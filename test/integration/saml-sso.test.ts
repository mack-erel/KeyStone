import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { POST as ssoPOST } from "../../src/routes/saml/sso/+server";
import { samlSessions } from "../../src/lib/server/db/schema";
import {
    openMemoryDb,
    seedTenantAndSigningKey,
    seedUser,
    seedSamlSp,
    seedServiceAssignment,
    seedSession,
    makeEvent,
    makeKeyCert,
    buildAuthnRequestXml,
    encodePostBindingSamlRequest,
    decodeSamlResponse,
    verifyAssertionSignatureInResponse,
    getIdpSigningCertPem,
    catchError,
    TEST_ISSUER_URL,
    type MemoryDb,
    type KeyCert,
} from "./harness";
import type { Tenant, User, Session, SamlSp } from "../../src/lib/server/db/schema";

// SAML SP-initiated HTTP-POST 바인딩을 실 DB(libSQL :memory:) + 실 /saml/sso POST 라우트로 검증한다.
// 서명된 AuthnRequest → 서비스 권한 게이트 → 서명된 SAML Response(ACS auto-submit 폼) 발급까지 풀플로우.

const SP_ENTITY_ID = "https://sp.test.example";
const SP_ACS_URL = "https://sp.test.example/acs";
const SSO_DESTINATION = `${TEST_ISSUER_URL}/saml/sso`;

let mem: MemoryDb;
let tenant: Tenant;
let user: User;
let session: Session;
let sp: SamlSp;
let spKc: KeyCert;

beforeEach(async () => {
    mem = await openMemoryDb();
    tenant = await seedTenantAndSigningKey(mem);
    spKc = await makeKeyCert("Test SP");
    user = await seedUser(mem.db, {
        tenantId: tenant.id,
        email: "sam@test.example",
        username: "sam",
        password: "sam-password-strong",
        displayName: "Sam Example",
    });
    session = (await seedSession(mem.db, { tenantId: tenant.id, userId: user.id })).session;
    sp = await seedSamlSp(mem.db, {
        tenantId: tenant.id,
        entityId: SP_ENTITY_ID,
        acsUrl: SP_ACS_URL,
        cert: spKc.certPem,
        wantAuthnRequestsSigned: true,
        // 서명 검증(단일 Assertion 서명)을 재검증하기 위해 Response 서명은 끈다.
        signResponse: false,
    });
});

afterEach(() => mem.close());

/** 서명된 AuthnRequest 를 POST 바인딩으로 /saml/sso 에 제출한다. */
async function postAuthnRequest(args: { id: string; loggedIn: boolean; assignUser: boolean; requestUser?: User; requestSession?: Session }): Promise<Response> {
    const xml = await buildAuthnRequestXml({
        id: args.id,
        kc: spKc,
        issuer: SP_ENTITY_ID,
        destination: SSO_DESTINATION,
        acsUrl: SP_ACS_URL,
        sign: true,
    });
    const samlRequest = encodePostBindingSamlRequest(xml);
    const u = args.requestUser ?? user;
    const s = args.requestSession ?? session;
    const event = makeEvent({
        method: "POST",
        url: SSO_DESTINATION,
        form: { SAMLRequest: samlRequest },
        locals: {
            db: mem.db,
            tenant,
            user: args.loggedIn ? u : null,
            session: args.loggedIn ? s : null,
            env: mem.env,
        },
    });
    return (await ssoPOST(event)) as Response;
}

/** auto-submit 폼 HTML 에서 SAMLResponse hidden input 값을 추출한다. */
function extractSamlResponseFromForm(html: string): string {
    const m = html.match(/name="SAMLResponse" value="([^"]+)"/);
    expect(m).not.toBeNull();
    return m![1];
}

describe("SAML SP-initiated POST 바인딩", () => {
    it("로그인+권한 부여 상태에서 서명된 AuthnRequest 는 서명·audience·ACS 가 일치하는 SAML Response 를 ACS 로 발급한다", async () => {
        await seedServiceAssignment(mem.db, { tenantId: tenant.id, userId: user.id, serviceType: "saml", serviceRefId: sp.id });

        const res = await postAuthnRequest({ id: "_authnreq_ok", loggedIn: true, assignUser: true });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");

        const html = await res.text();
        // ACS 로 auto-submit 하는 폼이어야 한다.
        expect(html).toContain(`action="${SP_ACS_URL}"`);

        const responseXml = decodeSamlResponse(extractSamlResponseFromForm(html));
        // InResponseTo = AuthnRequest ID, Destination = ACS, Audience = SP entityId, NameID = 사용자 이메일.
        expect(responseXml).toContain(`InResponseTo="_authnreq_ok"`);
        expect(responseXml).toContain(`Destination="${SP_ACS_URL}"`);
        expect(responseXml).toContain(`<saml:Audience>${SP_ENTITY_ID}</saml:Audience>`);
        expect(responseXml).toContain(`>${user.email}</saml:NameID>`);
        expect(responseXml).toContain("urn:oasis:names:tc:SAML:2.0:status:Success");

        // IdP 서명키로 Assertion 서명을 실제 재검증한다(SP 가 하는 방식과 동일하게 문서 컨텍스트 내 검증).
        const idpCert = await getIdpSigningCertPem(mem, tenant.id);
        expect(await verifyAssertionSignatureInResponse(responseXml, idpCert)).toBe(true);
        // 다른 인증서(SP 인증서)로는 검증되지 않아야 한다(서명이 IdP 키로 되어 있음).
        expect(await verifyAssertionSignatureInResponse(responseXml, spKc.certPem)).toBe(false);

        // saml_sessions 기록이 남아야 한다.
        const sessions = await mem.db.select().from(samlSessions).where(eq(samlSessions.userId, user.id));
        expect(sessions.length).toBe(1);
        expect(sessions[0].spId).toBe(sp.id);
        expect(sessions[0].nameId).toBe(user.email);
    });

    it("Assertion 서명 후 NameID 를 변조하면 서명 검증이 실패한다(서명이 실제로 내용을 커버)", async () => {
        await seedServiceAssignment(mem.db, { tenantId: tenant.id, userId: user.id, serviceType: "saml", serviceRefId: sp.id });
        const res = await postAuthnRequest({ id: "_authnreq_tamper", loggedIn: true, assignUser: true });
        const responseXml = decodeSamlResponse(extractSamlResponseFromForm(await res.text()));
        const tampered = responseXml.replace(`>${user.email}</saml:NameID>`, `>attacker@evil.example</saml:NameID>`);
        expect(tampered).not.toBe(responseXml);
        const idpCert = await getIdpSigningCertPem(mem, tenant.id);
        // 원본은 검증 통과, 변조본은 다이제스트 불일치로 실패해야 한다.
        expect(await verifyAssertionSignatureInResponse(responseXml, idpCert)).toBe(true);
        expect(await verifyAssertionSignatureInResponse(tampered, idpCert)).toBe(false);
    });

    it("서비스 권한 매핑이 없는 SP 접근은 403 으로 거부된다(기본 deny)", async () => {
        // seedServiceAssignment 를 하지 않음 → 게이트 실패.
        const { status } = await catchError(() => postAuthnRequest({ id: "_authnreq_denied", loggedIn: true, assignUser: false }));
        expect(status).toBe(403);
        // Assertion 이 발급되지 않았으므로 saml_sessions 기록도 없어야 한다.
        const sessions = await mem.db.select().from(samlSessions).where(eq(samlSessions.userId, user.id));
        expect(sessions.length).toBe(0);
    });

    it("동일 AuthnRequest ID 로 두 번째 Assertion 발급을 시도하면 replay 가드가 400 으로 거부한다", async () => {
        await seedServiceAssignment(mem.db, { tenantId: tenant.id, userId: user.id, serviceType: "saml", serviceRefId: sp.id });

        const first = await postAuthnRequest({ id: "_authnreq_replay", loggedIn: true, assignUser: true });
        expect(first.status).toBe(200);

        // 동일 AuthnRequest ID 재제출 → 이미 소비된 requestId → replay 거부.
        const { status } = await catchError(() => postAuthnRequest({ id: "_authnreq_replay", loggedIn: true, assignUser: true }));
        expect(status).toBe(400);

        // Assertion 은 최초 1회만 발급되어야 한다.
        const sessions = await mem.db.select().from(samlSessions).where(eq(samlSessions.userId, user.id));
        expect(sessions.length).toBe(1);
    });

    it("미로그인 상태의 SP-initiated 요청은 /login 으로 리다이렉트한다(Assertion 미발급)", async () => {
        await seedServiceAssignment(mem.db, { tenantId: tenant.id, userId: user.id, serviceType: "saml", serviceRefId: sp.id });
        // processSpInitiatedAuthnRequest 는 미로그인 시 redirect(302, /login...) 를 throw 한다.
        let redirected: { status?: number; location?: string } | null = null;
        try {
            await postAuthnRequest({ id: "_authnreq_nologin", loggedIn: false, assignUser: true });
        } catch (e) {
            redirected = e as { status?: number; location?: string };
        }
        expect(redirected?.status).toBe(302);
        expect(redirected?.location).toContain("/login");
        expect(redirected?.location).toContain("redirectTo=");
        const sessions = await mem.db.select().from(samlSessions).where(eq(samlSessions.userId, user.id));
        expect(sessions.length).toBe(0);
    });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET as authorizeGET } from "../../src/routes/oidc/authorize/+server";
import { POST as tokenPOST } from "../../src/routes/oidc/token/+server";
import { GET as userinfoGET } from "../../src/routes/oidc/userinfo/+server";
import { verifyIdToken } from "../../src/lib/server/crypto/keys";
import {
    openMemoryDb,
    seedTenantAndSigningKey,
    seedUser,
    seedOidcClient,
    seedServiceAssignment,
    seedSession,
    makeEvent,
    pkceChallengeS256,
    catchRedirect,
    TEST_ISSUER_URL,
    type MemoryDb,
} from "./harness";
import type { Tenant, User, Session } from "../../src/lib/server/db/schema";

// OIDC Authorization Code + PKCE 풀플로우를 실 DB(libSQL :memory:) + 실 라우트 핸들러로 검증한다.
// authorize(PKCE) → code → token(id_token/access_token/refresh_token) → userinfo, 그리고 code 1회 소진.

const CLIENT_ID = "test-web-client";
const CLIENT_SECRET = "s3cr3t-client-secret-value-0123456789";
const REDIRECT_URI = "https://app.test.example/callback";

let mem: MemoryDb;
let tenant: Tenant;
let user: User;
let session: Session;
let clientDbId: string;

beforeEach(async () => {
    mem = await openMemoryDb();
    tenant = await seedTenantAndSigningKey(mem);
    user = await seedUser(mem.db, {
        tenantId: tenant.id,
        email: "alice@test.example",
        username: "alice",
        password: "correct horse battery staple",
        displayName: "Alice Example",
    });
    const client = await seedOidcClient(mem.db, {
        tenantId: tenant.id,
        clientId: CLIENT_ID,
        secret: CLIENT_SECRET,
        redirectUris: [REDIRECT_URI],
        scopes: "openid profile email offline_access",
    });
    clientDbId = client.id;
    await seedServiceAssignment(mem.db, { tenantId: tenant.id, userId: user.id, serviceType: "oidc", serviceRefId: clientDbId });
    const seeded = await seedSession(mem.db, { tenantId: tenant.id, userId: user.id });
    session = seeded.session;
});

afterEach(() => {
    mem.close();
});

/** authorize 를 호출하고 발급된 authorization code 를 돌려준다. */
async function runAuthorize(verifier: string, opts: { state?: string; nonce?: string } = {}): Promise<string> {
    const challenge = await pkceChallengeS256(verifier);
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "openid profile email offline_access",
        code_challenge: challenge,
        code_challenge_method: "S256",
    });
    if (opts.state) params.set("state", opts.state);
    if (opts.nonce) params.set("nonce", opts.nonce);

    const event = makeEvent({
        method: "GET",
        url: `${TEST_ISSUER_URL}/oidc/authorize?${params.toString()}`,
        locals: { db: mem.db, tenant, user, session, env: mem.env },
    });

    const { status, location } = await catchRedirect(() => authorizeGET(event));
    expect(status).toBe(302);
    const dest = new URL(location);
    expect(`${dest.origin}${dest.pathname}`).toBe(REDIRECT_URI);
    const code = dest.searchParams.get("code");
    expect(code).toBeTruthy();
    if (opts.state) expect(dest.searchParams.get("state")).toBe(opts.state);
    return code!;
}

async function runToken(form: Record<string, string>): Promise<Response> {
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    return (await tokenPOST(
        makeEvent({
            method: "POST",
            url: `${TEST_ISSUER_URL}/oidc/token`,
            headers: { authorization: `Basic ${basic}` },
            form,
            locals: { db: mem.db, tenant, env: mem.env },
        }),
    )) as Response;
}

describe("OIDC 풀플로우 (authorize → token → userinfo)", () => {
    it("PKCE 인가코드 교환으로 id_token/access_token/refresh_token 을 발급하고 검증한다", async () => {
        const verifier = "pkce-verifier-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEFG";
        const code = await runAuthorize(verifier, { state: "xyz-state", nonce: "nonce-123" });

        const res = await runToken({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, string>;
        expect(body.token_type).toBe("Bearer");
        expect(body.access_token).toBeTruthy();
        expect(body.id_token).toBeTruthy();
        // offline_access 요청 + refresh_token grant 허용 → refresh token 발급
        expect(body.refresh_token).toBeTruthy();

        // 실 서명키로 id_token 서명 검증 + 클레임 확인
        const claims = await verifyIdToken(mem.db, tenant.id, body.id_token, { expectedIssuer: TEST_ISSUER_URL, expectedAud: CLIENT_ID });
        expect(claims).not.toBeNull();
        expect(claims!.sub).toBe(user.id);
        expect(claims!.iss).toBe(TEST_ISSUER_URL);
        expect(claims!.aud).toBe(CLIENT_ID);
        expect(claims!.nonce).toBe("nonce-123");
        expect(claims!.email).toBe("alice@test.example");
        expect(claims!.sid).toBe(session.id);

        // access token 으로 userinfo 조회
        const uinfo = (await userinfoGET(
            makeEvent({
                method: "GET",
                url: `${TEST_ISSUER_URL}/oidc/userinfo`,
                headers: { authorization: `Bearer ${body.access_token}` },
                locals: { db: mem.db, tenant, env: mem.env },
            }),
        )) as Response;
        expect(uinfo.status).toBe(200);
        const ui = (await uinfo.json()) as Record<string, unknown>;
        expect(ui.sub).toBe(user.id);
        expect(ui.email).toBe("alice@test.example");
        expect(ui.name).toBe("Alice Example");
    });

    it("authorization code 는 1회만 소진된다(재사용 거부)", async () => {
        const verifier = "verifier-second-case-zzzzzzzzzzzzzzzzzzzzzzzzz-000111222333";
        const code = await runAuthorize(verifier);

        const first = await runToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
        expect(first.status).toBe(200);

        const second = await runToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
        expect(second.status).toBe(400);
        const err = (await second.json()) as Record<string, string>;
        expect(err.error).toBe("invalid_grant");
    });

    it("PKCE code_verifier 불일치 시 거부한다", async () => {
        const verifier = "verifier-correct-value-mismatch-case-4444555566667777";
        const code = await runAuthorize(verifier);
        const res = await runToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: "wrong-verifier-value" });
        expect(res.status).toBe(400);
        expect(((await res.json()) as Record<string, string>).error).toBe("invalid_grant");
    });

    it("서비스 접근 권한 매핑이 없으면 SSO 를 거부한다(기본 deny)", async () => {
        // 권한 없는 별도 유저 + 세션으로 authorize 시도
        const other = await seedUser(mem.db, { tenantId: tenant.id, email: "mallory@test.example", username: "mallory", password: "pw" });
        const otherSession = (await seedSession(mem.db, { tenantId: tenant.id, userId: other.id })).session;
        const challenge = await pkceChallengeS256("verifier-denied-user-8888999900001111aaaa");
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            response_type: "code",
            scope: "openid",
            code_challenge: challenge,
            code_challenge_method: "S256",
        });
        const event = makeEvent({
            method: "GET",
            url: `${TEST_ISSUER_URL}/oidc/authorize?${params.toString()}`,
            locals: { db: mem.db, tenant, user: other, session: otherSession, env: mem.env },
        });
        const { location } = await catchRedirect(() => authorizeGET(event));
        const dest = new URL(location);
        expect(dest.searchParams.get("error")).toBe("access_denied");
        expect(dest.searchParams.get("code")).toBeNull();
    });
});

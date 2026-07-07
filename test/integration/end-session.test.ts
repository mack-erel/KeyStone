import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { GET as endSessionGET, POST as endSessionPOST } from "../../src/routes/oidc/end-session/+server";
import { b64uEncode, getActiveSigningKey, signJwt } from "../../src/lib/server/crypto/keys";
import { getRuntimeConfig } from "../../src/lib/server/auth/runtime";
import { oidcClients, sessions } from "../../src/lib/server/db/schema";
import { openMemoryDb, seedTenantAndSigningKey, seedUser, seedOidcClient, seedServiceAssignment, seedSession, makeEvent, makePlatform, catchRedirect, TEST_ISSUER_URL, type MemoryDb } from "./harness";
import type { Tenant, User, Session } from "../../src/lib/server/db/schema";

// RP-Initiated Logout (end-session) 을 실 DB + 실 라우트 핸들러로 검증한다.
// 핵심: id_token_hint 는 만료돼도 유효한 힌트다(OIDC RP-Initiated Logout §2) — 만료만 무시하고
// 서명/issuer/sub/aud/events 검증은 유지되는지 확인한다.

const CLIENT_ID = "test-logout-client";
const POST_LOGOUT_URI = "https://app.test.example/logged-out";

let mem: MemoryDb;
let tenant: Tenant;
let user: User;
let session: Session;

beforeEach(async () => {
    mem = await openMemoryDb();
    tenant = await seedTenantAndSigningKey(mem);
    user = await seedUser(mem.db, {
        tenantId: tenant.id,
        email: "alice@test.example",
        username: "alice",
        password: "correct horse battery staple",
    });
    const client = await seedOidcClient(mem.db, {
        tenantId: tenant.id,
        clientId: CLIENT_ID,
        secret: "s3cr3t-client-secret-value-0123456789",
        redirectUris: ["https://app.test.example/callback"],
    });
    await mem.db
        .update(oidcClients)
        .set({ postLogoutRedirectUris: JSON.stringify([POST_LOGOUT_URI]) })
        .where(eq(oidcClients.id, client.id));
    await seedServiceAssignment(mem.db, { tenantId: tenant.id, userId: user.id, serviceType: "oidc", serviceRefId: client.id });
    const seeded = await seedSession(mem.db, { tenantId: tenant.id, userId: user.id });
    session = seeded.session;
});

afterEach(() => {
    mem.close();
});

const nowSec = () => Math.floor(Date.now() / 1000);

/** 활성 서명키로 id_token 을 직접 서명한다(만료 등 클레임 임의 제어용). */
async function mintIdToken(claims: Record<string, unknown>): Promise<string> {
    const config = getRuntimeConfig(makePlatform(mem.env));
    const key = await getActiveSigningKey(mem.db, tenant.id, config.signingKeySecrets);
    if (!key) throw new Error("활성 서명키가 없습니다.");
    return signJwt(claims, key.privateKey, key.kid);
}

/** 로그인 시점 발급 후 TTL 이 지난 형태의 id_token 클레임. */
function expiredClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        iss: TEST_ISSUER_URL,
        sub: user.id,
        aud: CLIENT_ID,
        iat: nowSec() - 4200,
        exp: nowSec() - 3600,
        ...overrides,
    };
}

function makeGetEvent(params: Record<string, string>) {
    const qs = new URLSearchParams(params);
    return makeEvent({
        method: "GET",
        url: `${TEST_ISSUER_URL}/oidc/end-session?${qs.toString()}`,
        locals: { db: mem.db, tenant, user, session, env: mem.env },
    });
}

async function isSessionRevoked(): Promise<boolean> {
    const [row] = await mem.db.select({ revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.id, session.id)).limit(1);
    return row?.revokedAt != null;
}

describe("end-session: 만료 id_token_hint 수용 (RP-Initiated Logout §2)", () => {
    it("GET: 만료된 id_token_hint 로도 로그아웃 + 등록된 post_logout_redirect_uri 로 302", async () => {
        const hint = await mintIdToken(expiredClaims());
        const event = makeGetEvent({
            id_token_hint: hint,
            client_id: CLIENT_ID,
            post_logout_redirect_uri: POST_LOGOUT_URI,
            state: "xyz-state",
        });
        const { status, location } = await catchRedirect(() => endSessionGET(event));
        expect(status).toBe(302);
        const loc = new URL(location);
        expect(`${loc.origin}${loc.pathname}`).toBe(POST_LOGOUT_URI);
        expect(loc.searchParams.get("state")).toBe("xyz-state");
        expect(await isSessionRevoked()).toBe(true);
    });

    it("POST: 만료된 id_token_hint 로도 로그아웃 수행", async () => {
        const hint = await mintIdToken(expiredClaims());
        const event = makeEvent({
            method: "POST",
            url: `${TEST_ISSUER_URL}/oidc/end-session`,
            headers: { Origin: TEST_ISSUER_URL },
            form: {
                id_token_hint: hint,
                client_id: CLIENT_ID,
                post_logout_redirect_uri: POST_LOGOUT_URI,
            },
            locals: { db: mem.db, tenant, user, session, env: mem.env },
        });
        const { status, location } = await catchRedirect(() => endSessionPOST(event));
        expect(status).toBe(302);
        expect(location).toBe(POST_LOGOUT_URI);
        expect(await isSessionRevoked()).toBe(true);
    });
});

describe("end-session: 만료 무시는 만료 검사에만 한정 — 나머지 검증 유지", () => {
    it("서명 위조(payload 교체) 토큰은 만료 여부와 무관하게 거부", async () => {
        const token = await mintIdToken(expiredClaims());
        const [header, , sig] = token.split(".");
        const forgedPayload = b64uEncode(new TextEncoder().encode(JSON.stringify(expiredClaims({ sub: "attacker" }))));
        const event = makeGetEvent({ id_token_hint: `${header}.${forgedPayload}.${sig}` });
        const res = (await endSessionGET(event)) as Response;
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("invalid_id_token_hint");
        expect(await isSessionRevoked()).toBe(false);
    });

    it("issuer 불일치 토큰은 거부", async () => {
        const hint = await mintIdToken(expiredClaims({ iss: "https://evil.example" }));
        const event = makeGetEvent({ id_token_hint: hint });
        const res = (await endSessionGET(event)) as Response;
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("invalid_id_token_hint");
    });

    it("sub 가 현재 세션 사용자와 다르면 거부", async () => {
        const hint = await mintIdToken(expiredClaims({ sub: crypto.randomUUID() }));
        const event = makeGetEvent({ id_token_hint: hint });
        const res = (await endSessionGET(event)) as Response;
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("id_token_hint_mismatch");
        expect(await isSessionRevoked()).toBe(false);
    });

    it("client_id 명시 시 aud 불일치는 거부", async () => {
        const hint = await mintIdToken(expiredClaims({ aud: "some-other-client" }));
        const event = makeGetEvent({ id_token_hint: hint, client_id: CLIENT_ID });
        const res = (await endSessionGET(event)) as Response;
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("invalid_id_token_hint");
    });

    it("events claim 보유(BC logout token) 는 미만료여도 거부 (type-confusion 방어)", async () => {
        const hint = await mintIdToken({
            iss: TEST_ISSUER_URL,
            sub: user.id,
            aud: CLIENT_ID,
            iat: nowSec(),
            exp: nowSec() + 3600,
            events: { "http://schemas.openid.net/event/backchannel-logout": {} },
        });
        const event = makeGetEvent({ id_token_hint: hint });
        const res = (await endSessionGET(event)) as Response;
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("invalid_id_token_hint");
    });
});

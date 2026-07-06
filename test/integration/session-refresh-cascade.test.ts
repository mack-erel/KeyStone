import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { actions as sessionActions } from "../../src/routes/account/sessions/+page.server";
import { issueRefreshToken, rotateRefreshToken } from "../../src/lib/server/oidc/refresh";
import { oidcRefreshTokens, sessions } from "../../src/lib/server/db/schema";
import { openMemoryDb, seedTenantAndSigningKey, seedUser, seedSession, makeEvent, TEST_ISSUER_URL, type MemoryDb } from "./harness";
import type { Tenant, User, Session } from "../../src/lib/server/db/schema";

// Phase 6: 개별 세션 철회 → 그 세션에 묶인 OIDC refresh token 연쇄 폐기.
// 실제 account/sessions revoke 액션을 직접 호출해 검증한다.

let mem: MemoryDb;
let tenant: Tenant;
let user: User;
let sessionA: Session;
let sessionB: Session;

beforeEach(async () => {
    mem = await openMemoryDb();
    tenant = await seedTenantAndSigningKey(mem);
    user = await seedUser(mem.db, { tenantId: tenant.id, email: "bob@test.example", username: "bob", password: "pw" });
    sessionA = (await seedSession(mem.db, { tenantId: tenant.id, userId: user.id })).session;
    sessionB = (await seedSession(mem.db, { tenantId: tenant.id, userId: user.id })).session;
});

afterEach(() => mem.close());

async function activeTokenCount(sessionId: string): Promise<number> {
    const rows = await mem.db.select().from(oidcRefreshTokens).where(eq(oidcRefreshTokens.sessionId, sessionId));
    return rows.filter((r) => !r.revokedAt).length;
}

describe("Phase 6 — 세션 개별 철회 시 refresh token 연쇄 폐기", () => {
    it("revoke 액션이 대상 세션의 refresh token 만 폐기하고, 폐기된 토큰은 회전이 거부된다", async () => {
        // 두 세션 각각에 refresh token 발급
        const tokenA = await issueRefreshToken(mem.db, { tenantId: tenant.id, clientId: "c1", userId: user.id, sessionId: sessionA.id, scope: "openid offline_access" });
        await issueRefreshToken(mem.db, { tenantId: tenant.id, clientId: "c1", userId: user.id, sessionId: sessionB.id, scope: "openid offline_access" });

        expect(await activeTokenCount(sessionA.id)).toBe(1);
        expect(await activeTokenCount(sessionB.id)).toBe(1);

        // sessionA 를 개별 철회 (locals.session = sessionB 이므로 현재 세션이 아님 → JSON 반환)
        const event = makeEvent({
            method: "POST",
            url: `${TEST_ISSUER_URL}/account/sessions`,
            form: { id: sessionA.id },
            locals: { db: mem.db, tenant, user, session: sessionB, env: mem.env },
        });
        const result = await sessionActions.revoke(event);
        expect(result).toEqual({ revoked: true });

        // sessionA 의 refresh token 은 연쇄 폐기, sessionB 는 살아있음
        expect(await activeTokenCount(sessionA.id)).toBe(0);
        expect(await activeTokenCount(sessionB.id)).toBe(1);

        // 폐기된 토큰의 회전은 reuse 로 거부된다(연쇄 폐기 실효성 확인)
        const rot = await rotateRefreshToken(mem.db, tenant.id, "c1", tokenA);
        expect(rot.ok).toBe(false);
        if (!rot.ok) expect(rot.reason).toBe("reuse");

        // 세션 자체도 revoked 로 마킹됨
        const [sa] = await mem.db.select().from(sessions).where(eq(sessions.id, sessionA.id)).limit(1);
        expect(sa.revokedAt).not.toBeNull();
    });

    it("존재하지 않는 세션 id 는 404 로 거부한다(IDOR 방지 가드)", async () => {
        const event = makeEvent({
            method: "POST",
            url: `${TEST_ISSUER_URL}/account/sessions`,
            form: { id: crypto.randomUUID() },
            locals: { db: mem.db, tenant, user, session: sessionB, env: mem.env },
        });
        const result = (await sessionActions.revoke(event)) as { status?: number };
        expect(result.status).toBe(404);
    });
});

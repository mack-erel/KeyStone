import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { oidcRefreshTokens, sessions } from "../../src/lib/server/db/schema";
import { openMemoryDb, seedTenantAndSigningKey, seedUser, seedSession, makeEvent, TEST_ISSUER_URL, type MemoryDb } from "./harness";
import type { Tenant, User } from "../../src/lib/server/db/schema";

// 세션 철회 알림 경로: account/sessions 의 revoke 액션이 실제로 세션 + 연쇄 refresh 를 폐기하고
// 보안 알림(dispatchSecurityAlert)을 호출하는지 검증한다. 알림 sink(security-notify)만 모킹해
// 호출 여부/인자를 확인하고, 세션·refresh 폐기·감사로그는 실 DB 로 검증한다.
const dispatchMock = vi.fn();
vi.mock("../../src/lib/server/security-notify", () => ({
    dispatchSecurityAlert: (...args: unknown[]) => dispatchMock(...args),
}));

let mem: MemoryDb;
let tenant: Tenant;
let user: User;

beforeEach(async () => {
    mem = await openMemoryDb();
    tenant = await seedTenantAndSigningKey(mem);
    user = await seedUser(mem.db, { tenantId: tenant.id, email: "revoker@test.example", username: "revoker", password: "pw-strong-1" });
    dispatchMock.mockClear();
});

afterEach(() => mem.close());

describe("세션 철회 알림 경로 (account/sessions revoke)", () => {
    it("다른 세션을 철회하면 세션 폐기 + refresh 연쇄 폐기 + 보안 알림(session_revoked) 이 일어난다", async () => {
        const { actions } = await import("../../src/routes/account/sessions/+page.server");

        // 현재 세션 + 철회 대상 세션 2개 생성.
        const current = (await seedSession(mem.db, { tenantId: tenant.id, userId: user.id })).session;
        const other = (await seedSession(mem.db, { tenantId: tenant.id, userId: user.id })).session;

        // 철회 대상 세션에 묶인 refresh token 하나 시드 → 연쇄 폐기 확인용.
        const rtId = crypto.randomUUID();
        await mem.db.insert(oidcRefreshTokens).values({
            id: rtId,
            tenantId: tenant.id,
            clientId: "some-client",
            userId: user.id,
            sessionId: other.id,
            tokenHash: "rt-hash-" + rtId,
            scope: "openid offline_access",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });

        const event = makeEvent({
            method: "POST",
            url: `${TEST_ISSUER_URL}/account/sessions?/revoke`,
            form: { id: other.id },
            locals: { db: mem.db, tenant, user, session: current, env: mem.env },
        });
        const res = (await actions.revoke(event)) as { revoked?: boolean };
        expect(res.revoked).toBe(true);

        // 대상 세션은 revokedAt 이 채워지고, 현재 세션은 유지되어야 한다.
        const [revoked] = await mem.db.select().from(sessions).where(eq(sessions.id, other.id)).limit(1);
        expect(revoked.revokedAt).not.toBeNull();
        const [keep] = await mem.db.select().from(sessions).where(eq(sessions.id, current.id)).limit(1);
        expect(keep.revokedAt).toBeNull();

        // 연쇄 refresh token 폐기.
        const [rt] = await mem.db.select().from(oidcRefreshTokens).where(eq(oidcRefreshTokens.id, rtId)).limit(1);
        expect(rt.revokedAt).not.toBeNull();

        // 보안 알림이 session_revoked 로 사용자 이메일에 발송 요청되어야 한다.
        expect(dispatchMock).toHaveBeenCalledTimes(1);
        const arg = dispatchMock.mock.calls[0][0] as { to?: string; kind?: string };
        expect(arg.kind).toBe("session_revoked");
        expect(arg.to).toBe(user.email);
    });

    it("존재하지 않는 세션 id 는 404 로 거부하고 알림을 보내지 않는다", async () => {
        const { actions } = await import("../../src/routes/account/sessions/+page.server");
        const current = (await seedSession(mem.db, { tenantId: tenant.id, userId: user.id })).session;

        const event = makeEvent({
            method: "POST",
            url: `${TEST_ISSUER_URL}/account/sessions?/revoke`,
            form: { id: crypto.randomUUID() },
            locals: { db: mem.db, tenant, user, session: current, env: mem.env },
        });
        const res = (await actions.revoke(event)) as { status?: number };
        expect(res.status).toBe(404);
        expect(dispatchMock).not.toHaveBeenCalled();
    });
});

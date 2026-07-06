import { describe, it, expect } from "vitest";
import type { DB } from "$lib/server/db";
import { issueRefreshToken, revokeRefreshTokenFamily, rotateRefreshToken } from "$lib/server/oidc/refresh";

// ── mock 설계 요약 ────────────────────────────────────────────────────────────
// refresh.ts 가 활성 방언(테스트 = d1)에서 쓰는 호출 shape:
//   issueRefreshToken       : db.insert(tbl).values({...})                      (await)
//   revokeRefreshTokenFamily: db.update(tbl).set({revokedAt}).where(..)         (await)
//   rotateRefreshToken      :
//     1) db.select().from(tbl).where(..).limit(1)                → [record?]
//     2) runAtomic(db,[claim,insert]) → d1 경로에서 db.batch([...])
//        claim  = db.update(tbl).set({revokedAt,replacedById}).where(..).returning({id})
//        insert = db.insert(tbl).values({...})
//        batch 결과[0] 의 length>0 이면 claim 승자.
//
// 실제 계약 대응:
//   - .where() 는 revokeFamily 처럼 직접 await 될 수도(→ thenable), rotate claim 처럼
//     .returning() 이 이어질 수도 있어 둘 다 지원한다.
//   - .values()/.returning() 은 batch 에 수집될 때 __result 로 실행 결과를 노출하고,
//     직접 await 될 때(thenable)도 동작한다. batch 는 수집된 빌더의 __result 를
//     op 순서대로 돌려줘 runAtomic 계약(결과 배열=op 순서)을 재현한다.
interface MakeDbOpts {
    selectResult?: unknown[];
    claimReturning?: Array<{ id: string }>;
}
function makeDb(opts: MakeDbOpts = {}) {
    const inserts: Record<string, unknown>[] = [];
    const updateSets: Record<string, unknown>[] = [];
    let batchCalls = 0;
    const selectResult = opts.selectResult ?? [];
    const claimReturning = opts.claimReturning ?? [];

    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => selectResult,
                }),
            }),
        }),
        insert: () => ({
            values: (v: Record<string, unknown>) => {
                inserts.push(v);
                // batch 수집(__result) + 직접 await(thenable) 양쪽 지원.
                return { __result: undefined, then: (res: (x: unknown) => void) => res(undefined) };
            },
        }),
        update: () => ({
            set: (v: Record<string, unknown>) => {
                updateSets.push(v);
                return {
                    where: () => ({
                        // 직접 await(revokeFamily) 경로.
                        then: (res: (x: unknown) => void) => res(undefined),
                        // batch claim 경로.
                        returning: () => ({ __result: claimReturning, then: (res: (x: unknown) => void) => res(claimReturning) }),
                    }),
                };
            },
        }),
        batch: async (builders: Array<{ __result: unknown }>) => {
            batchCalls += 1;
            return builders.map((b) => b.__result);
        },
    };
    return {
        db: db as unknown as DB,
        inserts,
        updateSets,
        get batchCalls() {
            return batchCalls;
        },
    };
}

async function sha256Hex(input: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

const URLSAFE_B64 = /^[A-Za-z0-9_-]+$/;

function activeRecord(overrides: Record<string, unknown> = {}) {
    return {
        id: "rt-old",
        tenantId: "t1",
        clientId: "c1",
        userId: "u1",
        sessionId: "sess-1",
        scope: "openid offline_access",
        tokenHash: "oldhash",
        revokedAt: null,
        replacedById: null,
        expiresAt: new Date(Date.now() + 60_000),
        ...overrides,
    };
}

describe("issueRefreshToken — raw 토큰 미저장(해시만 보관)", () => {
    it("32바이트 URL-safe base64 토큰 반환 + SHA-256 해시만 insert", async () => {
        const { db, inserts } = makeDb();
        const before = Date.now();
        const token = await issueRefreshToken(db, { tenantId: "t1", clientId: "c1", userId: "u1", sessionId: "sess-1", scope: "openid" });

        expect(URLSAFE_B64.test(token)).toBe(true);
        expect(token.length).toBe(43); // 32바이트 base64url(패딩 제거)

        expect(inserts.length).toBe(1);
        const v = inserts[0];
        expect(v.token).toBeUndefined(); // 평문 토큰 컬럼 없음
        expect(v.tokenHash).toBe(await sha256Hex(token));
        expect(v.tokenHash).not.toBe(token);
        expect(v.tenantId).toBe("t1");
        expect(v.clientId).toBe("c1");
        expect(v.userId).toBe("u1");
        expect(v.sessionId).toBe("sess-1");
        expect(v.scope).toBe("openid");
        expect(typeof v.id).toBe("string");
        const exp = (v.expiresAt as Date).getTime();
        expect(exp).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000 - 2000);
    });
});

describe("revokeRefreshTokenFamily", () => {
    it("revokedAt 을 세팅하는 UPDATE 를 발행", async () => {
        const { db, updateSets } = makeDb();
        await revokeRefreshTokenFamily(db, "t1", "u1", "c1");
        expect(updateSets.length).toBe(1);
        expect(updateSets[0].revokedAt).toBeInstanceOf(Date);
    });
});

describe("rotateRefreshToken — 회전 성공 경로(runAtomic claim+insert)", () => {
    it("claim 승자 → { ok:true } + 새 토큰 발급, 새 토큰 해시만 insert", async () => {
        const record = activeRecord();
        const store = makeDb({ selectResult: [record], claimReturning: [{ id: "rt-new" }] });
        const { db, inserts, updateSets } = store;

        const res = await rotateRefreshToken(db, "t1", "c1", "presented-raw-token");
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error("unreachable");
        expect(res.record).toBe(record);
        expect(URLSAFE_B64.test(res.newToken)).toBe(true);
        expect(res.newToken.length).toBe(43);

        // 원자적 batch 가 한 번 실행됐다.
        expect(store.batchCalls).toBe(1);

        // claim UPDATE: revokedAt + replacedById 세팅(회전 링크).
        expect(updateSets.length).toBe(1);
        expect(updateSets[0].revokedAt).toBeInstanceOf(Date);
        expect(updateSets[0].replacedById).toBeDefined();

        // new 토큰은 해시로만 저장 — 평문 미저장, 원본 raw != 해시.
        expect(inserts.length).toBe(1);
        expect(inserts[0].token).toBeUndefined();
        expect(inserts[0].tokenHash).toBe(await sha256Hex(res.newToken));
        expect(inserts[0].userId).toBe("u1");
    });
});

describe("rotateRefreshToken — 거부/재사용 경로", () => {
    it("없는 토큰 → { ok:false, reason:'invalid_grant' }, batch/insert 없음", async () => {
        const store = makeDb({ selectResult: [] });
        const res = await rotateRefreshToken(store.db, "t1", "c1", "nope");
        expect(res).toEqual({ ok: false, reason: "invalid_grant" });
        expect(store.batchCalls).toBe(0);
        expect(store.inserts.length).toBe(0);
    });

    it("이미 revoke 된 토큰 재사용 → family 폐기 + { reason:'reuse' } (회전 없음)", async () => {
        const record = activeRecord({ revokedAt: new Date(Date.now() - 1000) });
        const store = makeDb({ selectResult: [record] });
        const { updateSets } = store;
        const res = await rotateRefreshToken(store.db, "t1", "c1", "reused");
        expect(res).toEqual({ ok: false, reason: "reuse" });
        // 회전 batch 는 실행되지 않고, family 폐기 UPDATE 만 발행.
        expect(store.batchCalls).toBe(0);
        expect(store.inserts.length).toBe(0);
        expect(updateSets.length).toBe(1);
        expect(updateSets[0].revokedAt).toBeInstanceOf(Date);
        expect(updateSets[0].replacedById).toBeUndefined(); // family 폐기는 revokedAt 만
    });

    it("revoked 이지만 미만료인 토큰도 재사용으로 감지(만료보다 revoke 우선 판정)", async () => {
        // revokedAt 검사가 expiresAt 검사보다 먼저 — 미만료여도 reuse 로 귀결되어야 한다.
        const record = activeRecord({ revokedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 60_000) });
        const store = makeDb({ selectResult: [record] });
        const res = await rotateRefreshToken(store.db, "t1", "c1", "reused-not-expired");
        expect(res).toEqual({ ok: false, reason: "reuse" });
        expect(store.batchCalls).toBe(0);
    });

    it("만료 토큰(미revoke) → { reason:'expired' }, family 폐기/회전 없음", async () => {
        const record = activeRecord({ revokedAt: null, expiresAt: new Date(Date.now() - 1000) });
        const store = makeDb({ selectResult: [record] });
        const res = await rotateRefreshToken(store.db, "t1", "c1", "expired");
        expect(res).toEqual({ ok: false, reason: "expired" });
        expect(store.batchCalls).toBe(0);
        expect(store.updateSets.length).toBe(0);
    });

    it("동시 회전 패자(claim 0행) → family 폐기 + { reason:'reuse' }", async () => {
        // 유효 토큰이지만 claim UPDATE 가 0행(다른 요청이 먼저 회전) → 재사용으로 간주.
        const record = activeRecord();
        const store = makeDb({ selectResult: [record], claimReturning: [] });
        const { updateSets } = store;
        const res = await rotateRefreshToken(store.db, "t1", "c1", "concurrent-loser");
        expect(res).toEqual({ ok: false, reason: "reuse" });
        expect(store.batchCalls).toBe(1); // batch 는 실행됨(패자도 insert 시도)
        expect(store.inserts.length).toBe(1); // 패자의 new 토큰도 삽입되지만 반환되지 않음
        // updateSets: [0]=claim(replacedById 有), [1]=family 폐기(revokedAt 만)
        expect(updateSets.length).toBe(2);
        expect(updateSets[0].replacedById).toBeDefined();
        expect(updateSets[1].replacedById).toBeUndefined();
        expect(updateSets[1].revokedAt).toBeInstanceOf(Date);
    });
});

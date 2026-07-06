import { describe, it, expect } from "vitest";
import type { DB } from "$lib/server/db";
import { createGrant, findAndConsumeGrant, type CreateGrantParams } from "$lib/server/oidc/grant";

// ── mock 설계 요약 ────────────────────────────────────────────────────────────
// grant.ts 는 활성 방언(테스트 = d1)에서 아래 두 호출 shape 만 쓴다:
//   createGrant           : db.insert(oidcGrants).values({...})            (await)
//   findAndConsumeGrant   : db.update(oidcGrants).set({usedAt}).where(..)  (원자적 claim)
//                            .returning()                                   (await → 소진된 row[])
// 실제 계약과 어긋나지 않도록 정확히 이 체인만 mock 하고, insert payload 와
// returning 결과를 캡처/주입한다. WHERE 가드(codeHash·tenant·client·isNull(usedAt)·
// gt(expiresAt))는 DB 가 강제하므로, mock 은 "claim 매칭 여부"를 returning 배열의
// 존재/부재로 표현한다 — 만료·이미소진·해시불일치는 모두 매칭 실패(빈 배열)로 귀결된다.
function makeDb(returningRows: unknown[] = []) {
    const inserts: Record<string, unknown>[] = [];
    const updateSets: Record<string, unknown>[] = [];
    const db = {
        insert: () => ({
            values: async (v: Record<string, unknown>) => {
                inserts.push(v);
            },
        }),
        update: () => ({
            set: (v: Record<string, unknown>) => {
                updateSets.push(v);
                return {
                    where: () => ({
                        returning: async () => returningRows,
                    }),
                };
            },
        }),
    };
    return { db: db as unknown as DB, inserts, updateSets };
}

// grant.ts 의 sha256Base64Url 와 동일 산식 — codeHash 계약 검증용.
async function sha256Base64Url(input: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    let bin = "";
    for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function grantParams(overrides: Partial<CreateGrantParams> = {}): CreateGrantParams {
    return {
        tenantId: "t1",
        clientId: "c1",
        userId: "u1",
        sessionId: "s1",
        code: "raw-authorization-code-xyz",
        codeChallenge: "chal",
        codeChallengeMethod: "S256",
        redirectUri: "https://rp.example/cb",
        scope: "openid profile",
        nonce: "n1",
        state: "st1",
        ...overrides,
    };
}

describe("createGrant — codeHash 기반 저장(평문 code 미저장)", () => {
    it("raw code 는 저장하지 않고 SHA-256 base64url 해시(codeHash)만 insert", async () => {
        const { db, inserts } = makeDb();
        const params = grantParams();
        await createGrant(db, params);

        expect(inserts.length).toBe(1);
        const v = inserts[0];
        // 평문 code 컬럼은 insert 페이로드에 존재하지 않아야 한다.
        expect(v.code).toBeUndefined();
        // codeHash 는 raw code 의 SHA-256 base64url 과 정확히 일치.
        expect(v.codeHash).toBe(await sha256Base64Url(params.code));
        expect(v.codeHash).not.toBe(params.code);
        // 나머지 필드 passthrough + 서버 생성 값.
        expect(typeof v.id).toBe("string");
        expect(v.tenantId).toBe("t1");
        expect(v.clientId).toBe("c1");
        expect(v.redirectUri).toBe("https://rp.example/cb");
        expect(v.expiresAt).toBeInstanceOf(Date);
    });

    it("expiresAt 는 now+5분(AUTH_CODE_TTL) 근방", async () => {
        const { db, inserts } = makeDb();
        const before = Date.now();
        await createGrant(db, grantParams());
        const exp = (inserts[0].expiresAt as Date).getTime();
        expect(exp).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 2000);
        expect(exp).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 2000);
    });
});

describe("findAndConsumeGrant — 원자적 1회 소진(d1 RETURNING)", () => {
    it("claim 성공(RETURNING 이 row 반환) 시 grant 반환 + usedAt 세팅 UPDATE 발행", async () => {
        const grant = { id: "g1", tenantId: "t1", clientId: "c1", scope: "openid" };
        const { db, updateSets } = makeDb([grant]);

        const res = await findAndConsumeGrant(db, "t1", "c1", "raw-authorization-code-xyz");
        expect(res).toBe(grant);
        // 원자적 claim: usedAt 을 세팅하는 UPDATE 가 정확히 한 번 발행됐다.
        expect(updateSets.length).toBe(1);
        expect(updateSets[0].usedAt).toBeInstanceOf(Date);
    });

    it("만료 grant: WHERE 가드(gt expiresAt)로 claim 미매칭 → RETURNING 빈 배열 → null", async () => {
        const { db, updateSets } = makeDb([]); // 매칭 row 없음
        const res = await findAndConsumeGrant(db, "t1", "c1", "expired-code");
        expect(res).toBeNull();
        // 소진 UPDATE 자체는 시도된다(원자적 claim). 매칭 0행이라 RETURNING 이 비어 null.
        expect(updateSets.length).toBe(1);
    });

    it("이미 소진된 grant: WHERE 가드(isNull usedAt)로 claim 미매칭 → null", async () => {
        const { db } = makeDb([]);
        const res = await findAndConsumeGrant(db, "t1", "c1", "already-used-code");
        expect(res).toBeNull();
    });

    it("해시 불일치(다른 code): 매칭 row 없음 → null", async () => {
        const { db } = makeDb([]);
        const res = await findAndConsumeGrant(db, "t1", "c1", "unknown-code");
        expect(res).toBeNull();
    });
});

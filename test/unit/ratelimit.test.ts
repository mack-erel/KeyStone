import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DB } from "$lib/server/db";
import { checkRateLimit } from "$lib/server/ratelimit/index";

// ── mock 설계 요약 ────────────────────────────────────────────────────────────
// checkRateLimit 가 활성 방언(테스트 = d1)에서 쓰는 호출 shape:
//   1) 현재 버킷 upsert:
//      db.insert(rateLimits).values({key,count,expiresAt})
//        .onConflictDoUpdate({target,set}).returning({count})  → [{count}]
//   2) 이전 버킷 조회:
//      db.select({count}).from(rateLimits).where(eq(key,prevKey)).limit(1) → [{count}?]
//
// 실제 계약 대응:
//   - upsert 의 returning 결과로 currentCount 를 주입한다(원자적 증가 후 카운트).
//   - select 결과로 prevCount 를 주입한다(이전 윈도우 버킷).
//   - insertValues 를 캡처해 currentKey(`key:windowIndex`)·expiresAt 를 검증한다.
//   시간은 vi.useFakeTimers 로 고정해 windowIndex·elapsed 를 결정론적으로 만든다.
interface MakeDbOpts {
    currentCount: number;
    prevCount?: number;
}
function makeDb(opts: MakeDbOpts) {
    let insertValues: Record<string, unknown> | undefined;
    const db = {
        insert: () => ({
            values: (v: Record<string, unknown>) => {
                insertValues = v;
                return {
                    onConflictDoUpdate: () => ({
                        returning: async () => [{ count: opts.currentCount }],
                    }),
                };
            },
        }),
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => (opts.prevCount === undefined ? [] : [{ count: opts.prevCount }]),
                }),
            }),
        }),
    };
    return {
        db: db as unknown as DB,
        get insertValues() {
            return insertValues;
        },
    };
}

// now=90000, windowMs=60000 → windowIndex=1, windowStart=60000, elapsed=30000 (윈도우 절반)
const NOW = 90_000;
const WINDOW = 60_000;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
    vi.useRealTimers();
});

describe("checkRateLimit — 한도 내/초과", () => {
    it("한도 내: allowed=true, remaining=limit-sliding, retryAfter=0", async () => {
        // prev=0, current=3 → sliding = floor(0*0.5)+3 = 3 ≤ 5
        const { db } = makeDb({ currentCount: 3, prevCount: 0 });
        const res = await checkRateLimit(db, "user:a", { windowMs: WINDOW, limit: 5 });
        expect(res.allowed).toBe(true);
        expect(res.remaining).toBe(2);
        expect(res.retryAfterMs).toBe(0);
    });

    it("초과: allowed=false, remaining=0, retryAfterMs=windowMs-elapsed", async () => {
        // prev=0, current=6 → sliding = 6 > 5
        const { db } = makeDb({ currentCount: 6, prevCount: 0 });
        const res = await checkRateLimit(db, "user:a", { windowMs: WINDOW, limit: 5 });
        expect(res.allowed).toBe(false);
        expect(res.remaining).toBe(0);
        // elapsed = 30000 → retryAfter = 60000-30000 = 30000
        expect(res.retryAfterMs).toBe(WINDOW - 30_000);
    });
});

describe("checkRateLimit — 슬라이딩 윈도우 감쇠 산식", () => {
    it("floor(prev*(1-elapsed/window)) + current 로 이전 버킷을 가중 감쇠", async () => {
        // elapsed=30000, factor=1-0.5=0.5. prev=4, current=1
        // sliding = floor(4*0.5)+1 = 2+1 = 3 ≤ 5 → 허용, remaining=2
        const { db } = makeDb({ currentCount: 1, prevCount: 4 });
        const res = await checkRateLimit(db, "user:a", { windowMs: WINDOW, limit: 5 });
        expect(res.allowed).toBe(true);
        // remaining 이 current(1)만이 아니라 감쇠된 prev(2)까지 반영해야 진짜 슬라이딩.
        expect(res.remaining).toBe(2);
    });

    it("감쇠된 prev 가중치로 한도를 넘으면 차단", async () => {
        // prev=10, current=1, factor=0.5 → floor(5)+1 = 6 > 5 → 차단
        const { db } = makeDb({ currentCount: 1, prevCount: 10 });
        const res = await checkRateLimit(db, "user:a", { windowMs: WINDOW, limit: 5 });
        expect(res.allowed).toBe(false);
        expect(res.remaining).toBe(0);
    });

    it("elapsed 비율에 따라 감쇠 강도가 달라진다(윈도우 초반엔 prev 가중치 큼)", async () => {
        // now=61000 → elapsed=1000, factor≈1-1000/60000. prev=5, current=1
        // floor(5*(1-1000/60000))+1 = floor(4.916..)+1 = 4+1 = 5 ≤ 5 → 허용(경계)
        vi.setSystemTime(new Date(61_000));
        const { db } = makeDb({ currentCount: 1, prevCount: 5 });
        const res = await checkRateLimit(db, "user:a", { windowMs: WINDOW, limit: 5 });
        expect(res.allowed).toBe(true);
        expect(res.remaining).toBe(0);
    });
});

describe("checkRateLimit — 키 네임스페이싱/버킷 만료", () => {
    it("current 버킷 key = `${key}:${windowIndex}`, expiresAt = windowStart + windowMs*2", async () => {
        const store = makeDb({ currentCount: 1, prevCount: 0 });
        await checkRateLimit(store.db, "user:a", { windowMs: WINDOW, limit: 5 });
        expect(store.insertValues?.key).toBe("user:a:1"); // windowIndex = floor(90000/60000) = 1
        expect(store.insertValues?.count).toBe(1);
        // windowStart(60000) + windowMs*2(120000) = 180000
        expect((store.insertValues?.expiresAt as Date).getTime()).toBe(60_000 + WINDOW * 2);
    });

    it("서로 다른 키는 서로 다른 버킷 key 로 격리된다", async () => {
        const a = makeDb({ currentCount: 1, prevCount: 0 });
        await checkRateLimit(a.db, "user:a", { windowMs: WINDOW, limit: 5 });
        const b = makeDb({ currentCount: 1, prevCount: 0 });
        await checkRateLimit(b.db, "user:b", { windowMs: WINDOW, limit: 5 });
        expect(a.insertValues?.key).toBe("user:a:1");
        expect(b.insertValues?.key).toBe("user:b:1");
        expect(a.insertValues?.key).not.toBe(b.insertValues?.key);
    });

    it("이전 버킷이 없으면(prev row 부재) prevCount=0 으로 취급", async () => {
        // prevCount undefined → select 빈 배열 → prevCount=0, sliding=current
        const { db } = makeDb({ currentCount: 5 });
        const res = await checkRateLimit(db, "user:a", { windowMs: WINDOW, limit: 5 });
        expect(res.allowed).toBe(true);
        expect(res.remaining).toBe(0); // 5-5
    });
});

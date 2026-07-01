/**
 * D1 기반 슬라이딩 윈도우 레이트 리밋 (두 버킷 근사법).
 *
 * 윈도우를 고정 인덱스(Math.floor(now/windowMs))로 분할해 두 버킷을 유지:
 *   - 현재 버킷 카운터를 원자적으로 증가
 *   - 이전 버킷 카운트에 경과 비율의 역수를 가중치로 적용
 *   count ≈ prev * (1 - elapsed/window) + current
 *
 * Fixed Window 대비 경계 burst(최대 2x) 문제를 제거.
 */

import { eq, sql } from "drizzle-orm";
import { type DB, DB_DIALECT } from "$lib/server/db";
import { rateLimits } from "$lib/server/db/schema";

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
}

export interface RateLimitOptions {
    /** 윈도우 크기 (ms) */
    windowMs: number;
    /** 윈도우 내 최대 허용 횟수 */
    limit: number;
}

export async function checkRateLimit(db: DB, key: string, options: RateLimitOptions): Promise<RateLimitResult> {
    const now = Date.now();
    const windowIndex = Math.floor(now / options.windowMs);
    const windowStart = windowIndex * options.windowMs;
    const elapsed = now - windowStart;

    const currentKey = `${key}:${windowIndex}`;
    const prevKey = `${key}:${windowIndex - 1}`;
    // 두 윈도우가 지나면 만료
    const currentExpiresAt = new Date(windowStart + options.windowMs * 2);

    // 현재 버킷 원자적 증가.
    // d1/postgres 는 upsert + RETURNING 을 지원하지만, MySQL 은 RETURNING 이 없으므로
    // ON DUPLICATE KEY UPDATE 후 재조회로 카운트를 얻는다.
    // 방언별 upsert API 차이를 캐스팅으로 흡수한다 (정규 DB 타입은 활성 방언 한 종류만
    // 노출하므로, 비활성 분기의 메서드는 타입에 존재하지 않아 캐스팅이 필요하다).
    let currentCount: number;
    const insertValues = { key: currentKey, count: 1, expiresAt: currentExpiresAt };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insertBuilder = db.insert(rateLimits).values(insertValues) as any;
    if (DB_DIALECT === "mysql") {
        // MySQL: RETURNING 미지원 → ON DUPLICATE KEY UPDATE 후 재조회.
        await insertBuilder.onDuplicateKeyUpdate({ set: { count: sql`${rateLimits.count} + 1` } });
        const [row] = await db.select({ count: rateLimits.count }).from(rateLimits).where(eq(rateLimits.key, currentKey)).limit(1);
        currentCount = row?.count ?? 1;
    } else {
        // d1 / postgres: upsert + RETURNING.
        const [row] = (await insertBuilder.onConflictDoUpdate({ target: rateLimits.key, set: { count: sql`${rateLimits.count} + 1` } }).returning({ count: rateLimits.count })) as Array<{
            count: number;
        }>;
        currentCount = row?.count ?? 1;
    }

    // 이전 버킷 조회 (best-effort)
    const [prevRow] = await db.select({ count: rateLimits.count }).from(rateLimits).where(eq(rateLimits.key, prevKey)).limit(1);

    const prevCount = prevRow?.count ?? 0;
    const slidingCount = Math.floor(prevCount * (1 - elapsed / options.windowMs)) + currentCount;

    if (slidingCount > options.limit) {
        return {
            allowed: false,
            remaining: 0,
            retryAfterMs: options.windowMs - elapsed,
        };
    }

    return {
        allowed: true,
        remaining: Math.max(0, options.limit - slidingCount),
        retryAfterMs: 0,
    };
}

/** 만료된 rate_limit 레코드를 정리 (주기적 호출 또는 훅에서 사용) */
export async function purgeExpiredRateLimits(db: DB): Promise<void> {
    await db.delete(rateLimits).where(sql`${rateLimits.expiresAt} <= ${Date.now()}`);
}

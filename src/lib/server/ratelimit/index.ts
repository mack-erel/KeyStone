/**
 * D1 기반 고정 윈도우 레이트 리밋.
 *
 * 테이블: rate_limits(key PK, count, expires_at)
 * - 윈도우가 만료됐으면 카운터 리셋
 * - 윈도우 내 count > limit 이면 차단
 */

import { sql } from "drizzle-orm";
import type { DB } from "$lib/server/db";
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

/**
 * 지정된 key 에 대해 레이트 리밋을 확인하고 카운터를 증가시킨다.
 *
 * SELECT→UPDATE 분리 대신 단일 INSERT...ON CONFLICT DO UPDATE...RETURNING 으로
 * 원자적으로 처리해 동시 요청 race condition 을 제거한다.
 */
export async function checkRateLimit(db: DB, key: string, options: RateLimitOptions): Promise<RateLimitResult> {
    const now = Date.now();
    const newExpiresAt = new Date(now + options.windowMs);

    // 단일 문으로 삽입/리셋/증가를 원자적으로 수행
    const [row] = await db
        .insert(rateLimits)
        .values({ key, count: 1, expiresAt: newExpiresAt })
        .onConflictDoUpdate({
            target: rateLimits.key,
            set: {
                count: sql`CASE WHEN ${rateLimits.expiresAt} <= ${now} THEN 1 ELSE ${rateLimits.count} + 1 END`,
                expiresAt: sql`CASE WHEN ${rateLimits.expiresAt} <= ${now} THEN ${newExpiresAt.getTime()} ELSE ${rateLimits.expiresAt} END`,
            },
        })
        .returning({ count: rateLimits.count, expiresAt: rateLimits.expiresAt });

    if (row.count > options.limit) {
        return {
            allowed: false,
            remaining: 0,
            retryAfterMs: row.expiresAt.getTime() - now,
        };
    }

    return {
        allowed: true,
        remaining: options.limit - row.count,
        retryAfterMs: 0,
    };
}

/** 만료된 rate_limit 레코드를 정리 (주기적 호출 또는 훅에서 사용) */
export async function purgeExpiredRateLimits(db: DB): Promise<void> {
    await db.delete(rateLimits).where(sql`${rateLimits.expiresAt} <= ${Date.now()}`);
}

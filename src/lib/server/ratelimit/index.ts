/**
 * D1 기반 고정 윈도우 레이트 리밋.
 *
 * 테이블: rate_limits(key PK, count, expires_at)
 * - 윈도우가 만료됐으면 카운터 리셋
 * - 윈도우 내 count > limit 이면 차단
 */

import { eq, sql } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { rateLimits } from '$lib/server/db/schema';

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
 */
export async function checkRateLimit(
	db: DB,
	key: string,
	options: RateLimitOptions
): Promise<RateLimitResult> {
	const now = Date.now();
	const newExpiresAt = new Date(now + options.windowMs);

	const [existing] = await db
		.select()
		.from(rateLimits)
		.where(eq(rateLimits.key, key))
		.limit(1);

	// 레코드 없거나 윈도우 만료 → 새 윈도우 시작
	if (!existing || existing.expiresAt.getTime() <= now) {
		await db
			.insert(rateLimits)
			.values({ key, count: 1, expiresAt: newExpiresAt })
			.onConflictDoUpdate({
				target: rateLimits.key,
				set: { count: 1, expiresAt: newExpiresAt }
			});
		return { allowed: true, remaining: options.limit - 1, retryAfterMs: 0 };
	}

	// 윈도우 내 — 이미 한도 초과
	if (existing.count >= options.limit) {
		return {
			allowed: false,
			remaining: 0,
			retryAfterMs: existing.expiresAt.getTime() - now
		};
	}

	// 카운터 증가
	await db
		.update(rateLimits)
		.set({ count: sql`${rateLimits.count} + 1` })
		.where(eq(rateLimits.key, key));

	return {
		allowed: true,
		remaining: options.limit - existing.count - 1,
		retryAfterMs: 0
	};
}

/** 만료된 rate_limit 레코드를 정리 (주기적 호출 또는 훅에서 사용) */
export async function purgeExpiredRateLimits(db: DB): Promise<void> {
	await db.delete(rateLimits).where(sql`${rateLimits.expiresAt} <= ${Date.now()}`);
}

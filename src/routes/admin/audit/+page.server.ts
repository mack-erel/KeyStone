import { desc, eq, and } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { auditEvents, users } from '$lib/server/db/schema';

const VALID_OUTCOMES = ['success', 'failure'] as const;
const LIMIT_OPTIONS = [50, 100, 200, 500] as const;

export const load: PageServerLoad = async ({ locals, url }) => {
	const { db, tenant } = requireDbContext(locals);

	const kindFilter = url.searchParams.get('kind')?.trim() || null;
	const outcomeFilter = url.searchParams.get('outcome')?.trim() || null;
	const limitParam = parseInt(url.searchParams.get('limit') ?? '100', 10);

	const outcome =
		VALID_OUTCOMES.includes(outcomeFilter as (typeof VALID_OUTCOMES)[number])
			? (outcomeFilter as 'success' | 'failure')
			: null;
	const limit = LIMIT_OPTIONS.includes(limitParam as (typeof LIMIT_OPTIONS)[number])
		? limitParam
		: 100;

	const conditions = [eq(auditEvents.tenantId, tenant.id)];
	if (kindFilter) conditions.push(eq(auditEvents.kind, kindFilter));
	if (outcome) conditions.push(eq(auditEvents.outcome, outcome));

	const rows = await db
		.select({
			id: auditEvents.id,
			kind: auditEvents.kind,
			outcome: auditEvents.outcome,
			ip: auditEvents.ip,
			createdAt: auditEvents.createdAt,
			detailJson: auditEvents.detailJson,
			userEmail: users.email
		})
		.from(auditEvents)
		.leftJoin(users, eq(auditEvents.userId, users.id))
		.where(and(...conditions))
		.orderBy(desc(auditEvents.createdAt))
		.limit(limit);

	// 필터 선택지용 kind 목록 (상위 200개에서 unique 추출)
	const kindRows = await db
		.selectDistinct({ kind: auditEvents.kind })
		.from(auditEvents)
		.where(eq(auditEvents.tenantId, tenant.id))
		.orderBy(auditEvents.kind);

	return {
		events: rows,
		kinds: kindRows.map((r) => r.kind),
		filters: { kind: kindFilter, outcome: outcomeFilter, limit }
	};
};

import { desc, eq, and, lt } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { auditEvents, users } from '$lib/server/db/schema';

const VALID_OUTCOMES = ['success', 'failure'] as const;
const PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ locals, url }) => {
	const { db, tenant } = requireDbContext(locals);

	const kindFilter = url.searchParams.get('kind')?.trim() || null;
	const outcomeFilter = url.searchParams.get('outcome')?.trim() || null;
	const cursorParam = url.searchParams.get('cursor')?.trim() || null;

	const outcome = VALID_OUTCOMES.includes(outcomeFilter as (typeof VALID_OUTCOMES)[number])
		? (outcomeFilter as 'success' | 'failure')
		: null;

	const cursorMs = cursorParam ? Number.parseInt(cursorParam, 10) : NaN;
	const cursor = Number.isFinite(cursorMs) ? new Date(cursorMs) : null;

	const conditions = [eq(auditEvents.tenantId, tenant.id)];
	if (kindFilter) conditions.push(eq(auditEvents.kind, kindFilter));
	if (outcome) conditions.push(eq(auditEvents.outcome, outcome));
	if (cursor) conditions.push(lt(auditEvents.createdAt, cursor));

	// PAGE_SIZE+1 행을 조회해 다음 페이지 유무를 한 번에 판단한다.
	const rowsPlusOne = await db
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
		.limit(PAGE_SIZE + 1);

	const hasMore = rowsPlusOne.length > PAGE_SIZE;
	const rows = hasMore ? rowsPlusOne.slice(0, PAGE_SIZE) : rowsPlusOne;
	const nextCursor = hasMore && rows.length > 0 ? rows[rows.length - 1].createdAt.getTime() : null;

	// 필터 선택지용 kind 목록
	const kindRows = await db
		.selectDistinct({ kind: auditEvents.kind })
		.from(auditEvents)
		.where(eq(auditEvents.tenantId, tenant.id))
		.orderBy(auditEvents.kind);

	return {
		events: rows,
		kinds: kindRows.map((r) => r.kind),
		filters: { kind: kindFilter, outcome: outcomeFilter },
		pageSize: PAGE_SIZE,
		nextCursor
	};
};

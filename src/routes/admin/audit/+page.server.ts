import { desc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { auditEvents, users } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const { db, tenant } = requireDbContext(locals);
	const rows = await db
		.select({
			id: auditEvents.id,
			kind: auditEvents.kind,
			outcome: auditEvents.outcome,
			createdAt: auditEvents.createdAt,
			detailJson: auditEvents.detailJson,
			userEmail: users.email
		})
		.from(auditEvents)
		.leftJoin(users, eq(auditEvents.userId, users.id))
		.where(eq(auditEvents.tenantId, tenant.id))
		.orderBy(desc(auditEvents.createdAt))
		.limit(100);

	return { events: rows };
};

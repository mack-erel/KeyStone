import { desc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { samlSps } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const { db, tenant } = requireDbContext(locals);
	const rows = await db
		.select({
			id: samlSps.id,
			entityId: samlSps.entityId,
			name: samlSps.name,
			acsUrl: samlSps.acsUrl,
			signAssertion: samlSps.signAssertion,
			enabled: samlSps.enabled,
			createdAt: samlSps.createdAt
		})
		.from(samlSps)
		.where(eq(samlSps.tenantId, tenant.id))
		.orderBy(desc(samlSps.createdAt));

	return { sps: rows };
};

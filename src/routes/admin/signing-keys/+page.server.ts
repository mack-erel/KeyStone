import { desc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { signingKeys } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const { db, tenant } = requireDbContext(locals);
	const rows = await db
		.select({
			id: signingKeys.id,
			kid: signingKeys.kid,
			alg: signingKeys.alg,
			use: signingKeys.use,
			active: signingKeys.active,
			createdAt: signingKeys.createdAt,
			rotatedAt: signingKeys.rotatedAt
		})
		.from(signingKeys)
		.where(eq(signingKeys.tenantId, tenant.id))
		.orderBy(desc(signingKeys.createdAt));

	return { keys: rows };
};

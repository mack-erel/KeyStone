import { desc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { users } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const { db, tenant } = requireDbContext(locals);
	const rows = await db
		.select({
			id: users.id,
			email: users.email,
			displayName: users.displayName,
			role: users.role,
			status: users.status,
			createdAt: users.createdAt
		})
		.from(users)
		.where(eq(users.tenantId, tenant.id))
		.orderBy(desc(users.createdAt));

	return { users: rows };
};

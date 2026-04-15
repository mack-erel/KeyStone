import { desc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { oidcClients } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const { db, tenant } = requireDbContext(locals);
	const rows = await db
		.select({
			id: oidcClients.id,
			clientId: oidcClients.clientId,
			name: oidcClients.name,
			scopes: oidcClients.scopes,
			enabled: oidcClients.enabled,
			createdAt: oidcClients.createdAt
		})
		.from(oidcClients)
		.where(eq(oidcClients.tenantId, tenant.id))
		.orderBy(desc(oidcClients.createdAt));

	return { clients: rows };
};

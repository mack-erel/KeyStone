import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { getPublicJwks } from '$lib/server/crypto/keys';

export const GET: RequestHandler = async ({ locals }) => {
	const { db, tenant } = requireDbContext(locals);
	const keys = await getPublicJwks(db, tenant.id);

	return json(
		{ keys },
		{
			headers: {
				'Cache-Control': 'public, max-age=3600'
			}
		}
	);
};

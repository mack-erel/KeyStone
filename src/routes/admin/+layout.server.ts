import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	requireDbContext(locals);

	if (!locals.user) {
		throw redirect(303, `/login?redirectTo=${encodeURIComponent(url.pathname + url.search)}`);
	}

	if (locals.user.role !== 'admin') {
		throw redirect(303, '/');
	}

	return {
		currentUser: {
			email: locals.user.email,
			displayName: locals.user.displayName,
			role: locals.user.role
		}
	};
};

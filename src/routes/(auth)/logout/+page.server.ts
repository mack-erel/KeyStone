import { redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getRequestMetadata, recordAuditEvent } from '$lib/server/audit';
import { requireDbContext } from '$lib/server/auth/guards';
import { clearSessionCookie, revokeSession } from '$lib/server/auth/session';
import { SESSION_COOKIE_NAME } from '$lib/server/auth/constants';

async function performLogout(event: RequestEvent) {
	const sessionToken = event.cookies.get(SESSION_COOKIE_NAME);

	if (sessionToken && event.locals.db && event.locals.tenant) {
		const { db, tenant } = requireDbContext(event.locals);
		const requestMetadata = getRequestMetadata(event);

		await revokeSession(db, sessionToken);

		if (event.locals.user) {
			await recordAuditEvent(db, {
				tenantId: tenant.id,
				userId: event.locals.user.id,
				actorId: event.locals.user.id,
				kind: 'logout',
				outcome: 'success',
				ip: requestMetadata.ip,
				userAgent: requestMetadata.userAgent,
			});
		}
	}

	clearSessionCookie(event.cookies, event.url);
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	return {};
};

export const actions: Actions = {
	default: async (event) => {
		await performLogout(event);
		throw redirect(303, '/login');
	},
};

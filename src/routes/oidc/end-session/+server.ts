import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { oidcClients } from '$lib/server/db/schema';
import { clearSessionCookie, revokeSession } from '$lib/server/auth/session';

async function handleEndSession(
	locals: App.Locals,
	url: URL,
	cookies: Parameters<RequestHandler>[0]['cookies']
): Promise<never> {
	const postLogoutRedirectUri = url.searchParams.get('post_logout_redirect_uri');
	const clientId = url.searchParams.get('client_id');

	// IdP 세션 폐기
	if (locals.session && locals.db) {
		await revokeSession(locals.db, locals.session.idpSessionId);
		clearSessionCookie(cookies, url);
	}

	// post_logout_redirect_uri 검증 후 리다이렉트
	if (postLogoutRedirectUri && clientId && locals.db && locals.tenant) {
		const [client] = await locals.db
			.select({ postLogoutRedirectUris: oidcClients.postLogoutRedirectUris })
			.from(oidcClients)
			.where(
				and(
					eq(oidcClients.tenantId, locals.tenant.id),
					eq(oidcClients.clientId, clientId),
					eq(oidcClients.enabled, true)
				)
			)
			.limit(1);

		if (client?.postLogoutRedirectUris) {
			const allowed = client.postLogoutRedirectUris.split(',').map((u) => u.trim());
			if (allowed.includes(postLogoutRedirectUri)) {
				throw redirect(302, postLogoutRedirectUri);
			}
		}
	}

	throw redirect(302, '/');
}

export const GET: RequestHandler = ({ locals, url, cookies }) =>
	handleEndSession(locals, url, cookies);

export const POST: RequestHandler = ({ locals, url, cookies }) =>
	handleEndSession(locals, url, cookies);

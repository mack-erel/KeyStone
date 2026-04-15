import type { Handle } from '@sveltejs/kit';
import { ensureAuthBaseline } from '$lib/server/auth/bootstrap';
import { SESSION_COOKIE_NAME, SESSION_TOUCH_INTERVAL_MS } from '$lib/server/auth/constants';
import { getRuntimeConfig } from '$lib/server/auth/runtime';
import { clearSessionCookie, getSessionContext, touchSession } from '$lib/server/auth/session';
import { getDb } from '$lib/server/db';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.db = undefined;
	event.locals.tenant = null;
	event.locals.session = null;
	event.locals.user = null;
	event.locals.runtimeConfig = getRuntimeConfig(event.platform);
	event.locals.runtimeError = null;

	try {
		if (event.platform?.env?.DB) {
			const db = getDb(event.platform);
			event.locals.db = db;
			event.locals.tenant = await ensureAuthBaseline(db, event.platform);

			const sessionToken = event.cookies.get(SESSION_COOKIE_NAME);

			if (sessionToken) {
				const sessionContext = await getSessionContext(db, sessionToken);

				if (sessionContext) {
					event.locals.session = sessionContext.session;
					event.locals.user = sessionContext.user;

					if (
						Date.now() - sessionContext.session.lastSeenAt.getTime() >=
						SESSION_TOUCH_INTERVAL_MS
					) {
						const now = new Date();
						await touchSession(db, sessionContext.session.id, now);
						event.locals.session.lastSeenAt = now;
					}
				} else {
					clearSessionCookie(event.cookies, event.url);
				}
			}
		}
	} catch (error) {
		event.locals.runtimeError =
			error instanceof Error ? error.message : '인증 컨텍스트 초기화 중 오류가 발생했습니다.';
		console.error(event.locals.runtimeError, error);
	}

	const response = await resolve(event);
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'same-origin');

	return response;
};

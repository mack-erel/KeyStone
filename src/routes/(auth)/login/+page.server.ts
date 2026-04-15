import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getRequestMetadata, recordAuditEvent } from '$lib/server/audit';
import { requireDbContext } from '$lib/server/auth/guards';
import { createSessionRecord, setSessionCookie } from '$lib/server/auth/session';
import { authenticateLocalUser, normalizeUsername } from '$lib/server/auth/users';

function sanitizeRedirectTarget(target: string | null): string | null {
	if (!target || !target.startsWith('/') || target.startsWith('//')) {
		return null;
	}

	return target;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.user) {
		throw redirect(302, locals.user.role === 'admin' ? '/admin' : '/');
	}

	return {
		redirectTo: sanitizeRedirectTarget(url.searchParams.get('redirectTo')),
		dbReady: Boolean(locals.db),
		runtimeError: locals.runtimeError
	};
};

export const actions: Actions = {
	default: async (event) => {
		const formData = await event.request.formData();
		const username = normalizeUsername(String(formData.get('username') ?? ''));
		const password = String(formData.get('password') ?? '');
		const redirectTo = sanitizeRedirectTarget(String(formData.get('redirectTo') ?? ''));

		if (!username || !password) {
			return fail(400, {
				username,
				redirectTo,
				error: '아이디와 비밀번호를 입력해 주세요.'
			});
		}

		if (!event.locals.db || !event.locals.tenant) {
			return fail(503, {
				username,
				redirectTo,
				error:
					event.locals.runtimeError ??
					'D1 binding "DB" 가 준비되지 않았습니다. Wrangler preview/dev 환경에서 실행해 주세요.'
			});
		}

		const { db, tenant } = requireDbContext(event.locals);
		const user = await authenticateLocalUser(db, tenant.id, username, password);
		const requestMetadata = getRequestMetadata(event);

		if (!user) {
			await recordAuditEvent(db, {
				tenantId: tenant.id,
				kind: 'login',
				outcome: 'failure',
				ip: requestMetadata.ip,
				userAgent: requestMetadata.userAgent,
				detail: { username }
			});

			return fail(400, {
				username,
				redirectTo,
				error: '아이디 또는 비밀번호가 올바르지 않습니다.'
			});
		}

		const { sessionToken, expiresAt } = await createSessionRecord(db, {
			tenantId: tenant.id,
			userId: user.id,
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent
		});

		setSessionCookie(event.cookies, event.url, sessionToken, expiresAt);
		await recordAuditEvent(db, {
			tenantId: tenant.id,
			userId: user.id,
			actorId: user.id,
			kind: 'login',
			outcome: 'success',
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent
		});

		throw redirect(303, user.role === 'admin' ? (redirectTo ?? '/admin') : (redirectTo ?? '/'));
	}
};

import { fail, redirect } from '@sveltejs/kit';
import { eq, and } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { getRequestMetadata, recordAuditEvent } from '$lib/server/audit';
import { requireDbContext } from '$lib/server/auth/guards';
import { createSessionRecord, setSessionCookie } from '$lib/server/auth/session';
import { authenticateLocalUser, normalizeUsername } from '$lib/server/auth/users';
import { createMfaPendingToken, MFA_PENDING_COOKIE } from '$lib/server/auth/mfa';
import { AMR_PASSWORD, TOTP_CREDENTIAL_TYPE } from '$lib/server/auth/constants';
import { getRuntimeConfig } from '$lib/server/auth/runtime';
import { credentials } from '$lib/server/db/schema';

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

		// TOTP 등록 여부 확인
		const [totpCredential] = await db
			.select({ id: credentials.id })
			.from(credentials)
			.where(and(eq(credentials.userId, user.id), eq(credentials.type, TOTP_CREDENTIAL_TYPE)))
			.limit(1);

		if (totpCredential) {
			// MFA 단계로 진행
			const config = getRuntimeConfig(event.platform);
			if (!config.signingKeySecret) {
				return fail(503, {
					username,
					redirectTo,
					error: 'MFA 설정 오류: IDP_SIGNING_KEY_SECRET 이 설정되지 않았습니다.'
				});
			}

			const mfaToken = await createMfaPendingToken(
				{ userId: user.id, tenantId: tenant.id, redirectTo },
				config.signingKeySecret
			);

			event.cookies.set(MFA_PENDING_COOKIE, mfaToken, {
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				secure: event.url.protocol === 'https:',
				maxAge: 5 * 60 // 5분
			});

			throw redirect(303, '/mfa');
		}

		// MFA 없음 — 세션 바로 생성
		const { sessionToken, expiresAt } = await createSessionRecord(db, {
			tenantId: tenant.id,
			userId: user.id,
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent,
			amr: [AMR_PASSWORD]
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

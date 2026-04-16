import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { getRuntimeConfig } from '$lib/server/auth/runtime';
import { recordAuditEvent, getRequestMetadata } from '$lib/server/audit/index';
import { createSessionRecord, setSessionCookie } from '$lib/server/auth/session';
import { AMR_WEBAUTHN } from '$lib/server/auth/constants';
import {
	verifyChallengeCookie,
	verifyPasskeyAuthentication,
	getWebAuthnConfig,
	WEBAUTHN_CHALLENGE_COOKIE
} from '$lib/server/auth/webauthn';
import type { AuthenticationResponseJSON } from '$lib/server/auth/webauthn';
import { users } from '$lib/server/db/schema';

export const POST: RequestHandler = async (event) => {
	const { locals, cookies, request, url, platform } = event;

	const config = getRuntimeConfig(platform);
	if (!config.signingKeySecret) {
		throw error(503, 'IDP_SIGNING_KEY_SECRET 이 설정되지 않았습니다.');
	}

	const cookieValue = cookies.get(WEBAUTHN_CHALLENGE_COOKIE);
	if (!cookieValue) {
		throw error(400, '인증 세션이 만료되었습니다. 다시 시도해 주세요.');
	}

	const payload = await verifyChallengeCookie(cookieValue, config.signingKeySecret, 'authenticate');
	if (!payload) {
		cookies.delete(WEBAUTHN_CHALLENGE_COOKIE, { path: '/' });
		throw error(400, '인증 세션이 유효하지 않습니다. 다시 시도해 주세요.');
	}

	const body = (await request.json()) as AuthenticationResponseJSON & { _redirectTo?: string };
	const { rpID, origin } = getWebAuthnConfig(url);

	const { db, tenant } = requireDbContext(locals);

	const result = await verifyPasskeyAuthentication(db, body, payload.challenge, rpID, origin);

	cookies.delete(WEBAUTHN_CHALLENGE_COOKIE, { path: '/' });

	if (!result) {
		const requestMetadata = getRequestMetadata(event);
		await recordAuditEvent(db, {
			tenantId: tenant.id,
			kind: 'login',
			outcome: 'failure',
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent,
			detail: { method: 'webauthn' }
		});
		throw error(400, '패스키 인증에 실패했습니다.');
	}

	// 사용자 조회
	const [user] = await db.select().from(users).where(eq(users.id, result.userId)).limit(1);

	if (!user || user.status !== 'active') {
		throw error(403, '비활성화된 계정입니다.');
	}

	if (user.tenantId !== tenant.id) {
		throw error(403, '접근 권한이 없습니다.');
	}

	const requestMetadata = getRequestMetadata(event);
	const { sessionToken, expiresAt } = await createSessionRecord(db, {
		tenantId: tenant.id,
		userId: user.id,
		ip: requestMetadata.ip,
		userAgent: requestMetadata.userAgent,
		amr: [AMR_WEBAUTHN]
	});

	setSessionCookie(cookies, url, sessionToken, expiresAt);

	await recordAuditEvent(db, {
		tenantId: tenant.id,
		userId: user.id,
		actorId: user.id,
		kind: 'login',
		outcome: 'success',
		ip: requestMetadata.ip,
		userAgent: requestMetadata.userAgent,
		detail: { method: 'webauthn' }
	});

	// SAML/OIDC 플로우에서 전달된 redirectTo 를 우선 사용 (내부 경로만 허용)
	const requested = body._redirectTo ?? '';
	const safeRedirect =
		requested && requested.startsWith('/') && !requested.startsWith('//')
			? requested
			: user.role === 'admin'
				? '/admin'
				: '/';

	return json({ ok: true, redirectTo: safeRedirect });
};

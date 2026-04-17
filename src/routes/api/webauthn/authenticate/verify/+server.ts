import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { recordAuditEvent, getRequestMetadata } from '$lib/server/audit/index';
import { createSessionRecord, setSessionCookie } from '$lib/server/auth/session';
import { AMR_WEBAUTHN, amrToAcr } from '$lib/server/auth/constants';
import { checkRateLimit } from '$lib/server/ratelimit';
import { verifyPasskeyAuthentication, consumeChallenge, getWebAuthnConfig } from '$lib/server/auth/webauthn';
import type { AuthenticationResponseJSON } from '$lib/server/auth/webauthn';
import { users } from '$lib/server/db/schema';

function extractChallengeFromClientData(clientDataJSONb64u: string): string | null {
	try {
		const b64 = clientDataJSONb64u.replace(/-/g, '+').replace(/_/g, '/');
		const bin = atob(b64);
		const arr = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
		const obj = JSON.parse(new TextDecoder().decode(arr)) as { challenge?: string };
		return typeof obj.challenge === 'string' ? obj.challenge : null;
	} catch {
		return null;
	}
}

export const POST: RequestHandler = async (event) => {
	const { locals, cookies, request, url } = event;

	const body = (await request.json()) as AuthenticationResponseJSON & { _redirectTo?: string };
	const { rpID, origin } = getWebAuthnConfig(url);

	const { db, tenant } = requireDbContext(locals);

	// 레이트 리밋: credentialId 기반 (userId 가 검증 전에는 미상). 5분/10회.
	const rlKey = `webauthn-verify:${tenant.id}:${body.id ?? 'none'}`;
	const rl = await checkRateLimit(db, rlKey, { windowMs: 5 * 60 * 1000, limit: 10 });
	if (!rl.allowed) {
		throw error(429, '인증 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
	}

	// 1회용 challenge 소진 (DB 기반)
	const clientChallenge = body.response?.clientDataJSON ? extractChallengeFromClientData(body.response.clientDataJSON) : null;
	if (!clientChallenge) {
		throw error(400, '인증 세션이 유효하지 않습니다.');
	}
	const challengeOk = await consumeChallenge(db, clientChallenge);
	if (!challengeOk) {
		throw error(400, '인증 세션이 만료되었거나 이미 사용되었습니다.');
	}

	const result = await verifyPasskeyAuthentication(db, body, clientChallenge, rpID, origin, tenant.id);

	if (!result) {
		const requestMetadata = getRequestMetadata(event);
		await recordAuditEvent(db, {
			tenantId: tenant.id,
			kind: 'login',
			outcome: 'failure',
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent,
			detail: { method: 'webauthn' },
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
		amr: [AMR_WEBAUTHN],
		acr: amrToAcr([AMR_WEBAUTHN]),
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
		detail: { method: 'webauthn' },
	});

	// SAML/OIDC 플로우에서 전달된 redirectTo 를 우선 사용 (내부 경로만 허용)
	const requested = body._redirectTo ?? '';
	let safeRedirect: string;
	try {
		const decoded = decodeURIComponent(requested);
		safeRedirect = decoded && decoded.startsWith('/') && !decoded.startsWith('//') && !decoded.includes('\\') ? requested : user.role === 'admin' ? '/admin' : '/';
	} catch {
		safeRedirect = user.role === 'admin' ? '/admin' : '/';
	}

	return json({ ok: true, redirectTo: safeRedirect });
};

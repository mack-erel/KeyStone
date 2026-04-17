import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { recordAuditEvent, getRequestMetadata } from '$lib/server/audit';
import { findOidcClient, isAllowedRedirectUri, parseGrantedScopes } from '$lib/server/oidc/client';
import { createGrant } from '$lib/server/oidc/grant';
import { checkRateLimit } from '$lib/server/ratelimit';

/** redirect_uri 가 확정된 이후에만 사용. 그 전 오류는 throw error() 로 직접 응답. */
function authRedirectError(
	redirectUri: string,
	errorCode: string,
	description: string,
	state?: string | null
): never {
	const dest = new URL(redirectUri);
	dest.searchParams.set('error', errorCode);
	dest.searchParams.set('error_description', description);
	if (state) dest.searchParams.set('state', state);
	throw redirect(302, dest.toString());
}

export const GET: RequestHandler = async (event) => {
	const { locals, url } = event;
	const { db, tenant } = requireDbContext(locals);

	// IP당 60회/분 제한 — grant INSERT DoS 방지
	const { ip } = getRequestMetadata(event);
	const rl = await checkRateLimit(db, `oidc-authorize:${ip ?? 'unknown'}`, {
		windowMs: 60 * 1000,
		limit: 60
	});
	if (!rl.allowed) {
		throw error(429, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
	}

	const clientId = url.searchParams.get('client_id');
	const redirectUri = url.searchParams.get('redirect_uri');
	const responseType = url.searchParams.get('response_type');
	const scope = url.searchParams.get('scope') ?? 'openid';
	const state = url.searchParams.get('state');
	const nonce = url.searchParams.get('nonce');
	const codeChallenge = url.searchParams.get('code_challenge');
	const codeChallengeMethod = url.searchParams.get('code_challenge_method');

	// client_id / redirect_uri 가 없으면 redirect 불가 → 직접 오류 응답
	if (!clientId || !redirectUri) {
		throw error(400, 'client_id 와 redirect_uri 는 필수입니다.');
	}
	if (responseType !== 'code') {
		throw error(400, 'response_type=code 만 지원합니다.');
	}

	const client = await findOidcClient(db, tenant.id, clientId);
	if (!client) {
		throw error(401, '등록되지 않은 client_id 입니다.');
	}

	if (!isAllowedRedirectUri(client, redirectUri)) {
		throw error(400, 'redirect_uri 가 등록된 값과 일치하지 않습니다.');
	}

	// PKCE 검증
	if (client.requirePkce) {
		if (!codeChallenge) {
			authRedirectError(
				redirectUri,
				'invalid_request',
				'PKCE code_challenge 가 필요합니다.',
				state
			);
		}
		if (codeChallengeMethod !== 'S256') {
			authRedirectError(
				redirectUri,
				'invalid_request',
				'code_challenge_method=S256 만 지원합니다.',
				state
			);
		}
	}

	// scope 검증
	const grantedScopes = parseGrantedScopes(client, scope);
	if (!grantedScopes.includes('openid')) {
		authRedirectError(redirectUri, 'invalid_scope', 'openid scope 가 필요합니다.', state);
	}
	const grantedScope = grantedScopes.join(' ');

	// 로그인 여부 확인
	if (!locals.user || !locals.session) {
		const loginUrl = new URL('/login', url);
		loginUrl.searchParams.set('redirectTo', url.pathname + url.search);
		throw redirect(302, loginUrl.toString());
	}

	// authorization code 발급
	const code = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

	await createGrant(db, {
		tenantId: tenant.id,
		clientId,
		userId: locals.user.id,
		sessionId: locals.session.id,
		code,
		codeChallenge: codeChallenge ?? null,
		codeChallengeMethod: (codeChallengeMethod as 'S256' | 'plain' | null) ?? null,
		redirectUri,
		scope: grantedScope,
		nonce: nonce ?? null,
		state: state ?? null,
		acr: locals.session.acr ?? null
	});

	const { userAgent } = getRequestMetadata(event);
	await recordAuditEvent(db, {
		tenantId: tenant.id,
		userId: locals.user.id,
		actorId: locals.user.id,
		spOrClientId: clientId,
		kind: 'oidc_authorize',
		outcome: 'success',
		ip,
		userAgent,
		detail: { clientId, scope: grantedScope }
	});

	const callbackUrl = new URL(redirectUri);
	callbackUrl.searchParams.set('code', code);
	if (state) callbackUrl.searchParams.set('state', state);
	throw redirect(302, callbackUrl.toString());
};

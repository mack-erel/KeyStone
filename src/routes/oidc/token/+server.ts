import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { findActiveUserById } from '$lib/server/auth/users';
import { recordAuditEvent } from '$lib/server/audit';
import { checkRateLimit } from '$lib/server/ratelimit';
import { findOidcClient, isValidClientSecret, parseBasicAuth } from '$lib/server/oidc/client';
import { consumeGrant, findGrant } from '$lib/server/oidc/grant';
import { verifyPkce } from '$lib/server/oidc/pkce';
import { generateAccessToken, getActiveSigningKey, signJwt } from '$lib/server/crypto/keys';

const ACCESS_TOKEN_TTL_S = 3600; // 1시간
const ID_TOKEN_TTL_S = 600; // 10분

function tokenError(code: string, description: string, status = 400): Response {
	return new Response(JSON.stringify({ error: code, error_description: description }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

export const POST: RequestHandler = async ({ locals, request, url }) => {
	const { db, tenant } = requireDbContext(locals);
	const { signingKeySecret, issuerUrl } = locals.runtimeConfig;

	// 레이트 리밋: IP당 30회/분
	const ip =
		request.headers.get('cf-connecting-ip') ??
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
		'unknown';
	const rl = await checkRateLimit(db, `token:${ip}`, { windowMs: 60 * 1000, limit: 30 });
	if (!rl.allowed) {
		return new Response(
			JSON.stringify({
				error: 'rate_limit_exceeded',
				error_description: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'
			}),
			{
				status: 429,
				headers: {
					'Content-Type': 'application/json',
					'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000))
				}
			}
		);
	}

	if (!signingKeySecret) {
		return tokenError('server_error', 'IDP_SIGNING_KEY_SECRET 가 설정되지 않았습니다.', 503);
	}

	const issuer = issuerUrl ?? url.origin;
	const body = await request.formData();

	if (body.get('grant_type') !== 'authorization_code') {
		return tokenError('unsupported_grant_type', 'authorization_code 만 지원합니다.');
	}

	// 클라이언트 인증 (Basic 헤더 또는 body params)
	let clientId = '';
	let clientSecret = '';

	const authHeader = request.headers.get('Authorization');
	if (authHeader) {
		const parsed = parseBasicAuth(authHeader);
		if (!parsed) return tokenError('invalid_client', '잘못된 Authorization 헤더입니다.', 401);
		clientId = parsed.clientId;
		clientSecret = parsed.clientSecret;
	} else {
		clientId = String(body.get('client_id') ?? '');
		clientSecret = String(body.get('client_secret') ?? '');
	}

	if (!clientId) {
		return tokenError('invalid_client', 'client_id 가 필요합니다.', 401);
	}

	const client = await findOidcClient(db, tenant.id, clientId);
	if (!client) {
		return tokenError('invalid_client', '등록되지 않은 클라이언트입니다.', 401);
	}

	if (!isValidClientSecret(client, clientSecret)) {
		return tokenError('invalid_client', '클라이언트 인증에 실패했습니다.', 401);
	}

	const code = String(body.get('code') ?? '');
	const redirectUri = String(body.get('redirect_uri') ?? '');
	const codeVerifier = String(body.get('code_verifier') ?? '');

	if (!code || !redirectUri) {
		return tokenError('invalid_request', 'code 와 redirect_uri 는 필수입니다.');
	}

	const grant = await findGrant(db, tenant.id, clientId, code);
	if (!grant) {
		return tokenError('invalid_grant', '유효하지 않거나 만료된 authorization code 입니다.');
	}

	if (grant.redirectUri !== redirectUri) {
		return tokenError('invalid_grant', 'redirect_uri 가 일치하지 않습니다.');
	}

	// PKCE 검증
	if (grant.codeChallenge) {
		if (!codeVerifier) {
			return tokenError('invalid_grant', 'code_verifier 가 필요합니다.');
		}
		const valid = await verifyPkce(grant.codeChallenge, grant.codeChallengeMethod ?? 'plain', codeVerifier);
		if (!valid) {
			return tokenError('invalid_grant', 'code_verifier 검증에 실패했습니다.');
		}
	}

	// code 소진 처리 (replay 방지)
	await consumeGrant(db, grant.id);

	const user = await findActiveUserById(db, grant.userId);
	if (!user) {
		return tokenError('invalid_grant', '사용자를 찾을 수 없습니다.');
	}

	const signingKey = await getActiveSigningKey(db, tenant.id, signingKeySecret);
	if (!signingKey) {
		return tokenError('server_error', '활성 서명 키를 찾을 수 없습니다.', 503);
	}

	const nowSec = Math.floor(Date.now() / 1000);
	const scopes = new Set(grant.scope.split(' '));

	// ID Token (RS256 JWT)
	const idTokenPayload: Record<string, unknown> = {
		iss: issuer,
		sub: user.id,
		aud: clientId,
		iat: nowSec,
		exp: nowSec + ID_TOKEN_TTL_S
	};

	// email scope
	if (scopes.has('email')) {
		idTokenPayload.email = user.email;
		idTokenPayload.email_verified = Boolean(user.emailVerifiedAt);
	}

	// profile scope
	if (scopes.has('profile')) {
		idTokenPayload.name = user.displayName;
		idTokenPayload.given_name = user.givenName;
		idTokenPayload.family_name = user.familyName;
		idTokenPayload.preferred_username = user.username ?? user.email.split('@')[0];
		idTokenPayload.picture = user.avatarUrl;
		idTokenPayload.locale = user.locale;
		idTokenPayload.zoneinfo = user.zoneinfo;
		idTokenPayload.birthdate = user.birthdate;
	}

	// phone scope
	if (scopes.has('phone')) {
		idTokenPayload.phone_number = user.phoneNumber;
		idTokenPayload.phone_number_verified = Boolean(user.phoneVerifiedAt);
	}

	if (grant.nonce) idTokenPayload.nonce = grant.nonce;
	if (grant.sessionId) idTokenPayload.sid = grant.sessionId;

	const idToken = await signJwt(idTokenPayload, signingKey.privateKey, signingKey.kid);

	// Opaque access token (HMAC-SHA256)
	const accessToken = await generateAccessToken(
		{
			sub: user.id,
			tenantId: tenant.id,
			clientId,
			scope: grant.scope,
			iat: nowSec,
			exp: nowSec + ACCESS_TOKEN_TTL_S
		},
		signingKeySecret
	);

	await recordAuditEvent(db, {
		tenantId: tenant.id,
		userId: user.id,
		actorId: user.id,
		spOrClientId: clientId,
		kind: 'oidc_token',
		outcome: 'success',
		detail: { clientId, scope: grant.scope }
	});

	return json({
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: ACCESS_TOKEN_TTL_S,
		scope: grant.scope,
		id_token: idToken
	});
};

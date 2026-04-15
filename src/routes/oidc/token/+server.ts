import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { requireDbContext } from '$lib/server/auth/guards';
import { recordAuditEvent } from '$lib/server/audit';
import { oidcClients, oidcGrants, users } from '$lib/server/db/schema';
import {
	b64uEncode,
	generateAccessToken,
	getActiveSigningKey,
	signJwt
} from '$lib/server/crypto/keys';

const ACCESS_TOKEN_TTL_S = 3600; // 1시간
const ID_TOKEN_TTL_S = 600; // 10분

function tokenError(code: string, description: string, status = 400): Response {
	return new Response(JSON.stringify({ error: code, error_description: description }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

async function verifySha256Challenge(verifier: string, challenge: string): Promise<boolean> {
	const enc = new TextEncoder();
	const hash = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
	return b64uEncode(hash) === challenge;
}

export const POST: RequestHandler = async ({ locals, request, url }) => {
	const { db, tenant } = requireDbContext(locals);
	const { signingKeySecret, issuerUrl } = locals.runtimeConfig;

	if (!signingKeySecret) {
		return tokenError(
			'server_error',
			'IDP_SIGNING_KEY_SECRET 가 설정되지 않았습니다.',
			503
		);
	}

	const issuer = issuerUrl ?? url.origin;

	const body = await request.formData();

	if (body.get('grant_type') !== 'authorization_code') {
		return tokenError('unsupported_grant_type', 'authorization_code 만 지원합니다.');
	}

	// 클라이언트 인증 (Basic 또는 body params)
	let clientId = '';
	let clientSecret = '';

	const authHeader = request.headers.get('Authorization');
	if (authHeader?.startsWith('Basic ')) {
		const decoded = atob(authHeader.slice(6));
		const sep = decoded.indexOf(':');
		clientId = sep > -1 ? decoded.slice(0, sep) : decoded;
		clientSecret = sep > -1 ? decoded.slice(sep + 1) : '';
	} else {
		clientId = String(body.get('client_id') ?? '');
		clientSecret = String(body.get('client_secret') ?? '');
	}

	if (!clientId) {
		return tokenError('invalid_client', 'client_id 가 필요합니다.', 401);
	}

	const [client] = await db
		.select()
		.from(oidcClients)
		.where(
			and(
				eq(oidcClients.tenantId, tenant.id),
				eq(oidcClients.clientId, clientId),
				eq(oidcClients.enabled, true)
			)
		)
		.limit(1);

	if (!client) {
		return tokenError('invalid_client', '등록되지 않은 클라이언트입니다.', 401);
	}

	// 기밀 클라이언트 시크릿 검증 (M1: 평문 비교 — M2 에서 해시 비교로 전환)
	if (client.tokenEndpointAuthMethod !== 'none') {
		if (!client.clientSecretHash || !clientSecret || clientSecret !== client.clientSecretHash) {
			return tokenError('invalid_client', '클라이언트 인증에 실패했습니다.', 401);
		}
	}

	const code = String(body.get('code') ?? '');
	const redirectUri = String(body.get('redirect_uri') ?? '');
	const codeVerifier = String(body.get('code_verifier') ?? '');

	if (!code || !redirectUri) {
		return tokenError('invalid_request', 'code 와 redirect_uri 는 필수입니다.');
	}

	// authorization code 조회 및 검증
	const now = new Date();
	const [grant] = await db
		.select()
		.from(oidcGrants)
		.where(
			and(
				eq(oidcGrants.code, code),
				eq(oidcGrants.tenantId, tenant.id),
				eq(oidcGrants.clientId, clientId),
				isNull(oidcGrants.usedAt),
				gt(oidcGrants.expiresAt, now)
			)
		)
		.limit(1);

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
		if (grant.codeChallengeMethod === 'S256') {
			const valid = await verifySha256Challenge(codeVerifier, grant.codeChallenge);
			if (!valid) return tokenError('invalid_grant', 'code_verifier 검증에 실패했습니다.');
		} else if (grant.codeChallengeMethod === 'plain') {
			if (codeVerifier !== grant.codeChallenge) {
				return tokenError('invalid_grant', 'code_verifier 검증에 실패했습니다.');
			}
		}
	}

	// code 를 소진 처리 (replay 방지)
	await db.update(oidcGrants).set({ usedAt: now }).where(eq(oidcGrants.id, grant.id));

	// 사용자 조회
	const [user] = await db
		.select()
		.from(users)
		.where(and(eq(users.id, grant.userId), eq(users.status, 'active')))
		.limit(1);

	if (!user) {
		return tokenError('invalid_grant', '사용자를 찾을 수 없습니다.');
	}

	// 서명 키 조회
	const signingKey = await getActiveSigningKey(db, tenant.id, signingKeySecret);
	if (!signingKey) {
		return tokenError('server_error', '활성 서명 키를 찾을 수 없습니다.', 503);
	}

	const nowSec = Math.floor(Date.now() / 1000);

	// ID Token (RS256 JWT)
	const idTokenPayload: Record<string, unknown> = {
		iss: issuer,
		sub: user.id,
		aud: clientId,
		iat: nowSec,
		exp: nowSec + ID_TOKEN_TTL_S,
		email: user.email,
		name: user.displayName,
		preferred_username: user.username ?? user.email.split('@')[0]
	};
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

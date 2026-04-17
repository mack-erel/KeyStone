import { json, error } from '@sveltejs/kit';

/**
 * PoC: RS256 JWT 서명/검증 — Cloudflare Workers WebCrypto 네이티브.
 * 외부 의존성 없음. OIDC ID Token 발급에 그대로 사용 가능함을 입증.
 *
 * GET /poc/rs256
 */
export const GET = async () => {
	if (!import.meta.env.DEV) throw error(404, 'Not found');
	const t0 = Date.now();

	// 1) 키쌍 생성 (RS256)
	const keyPair = await crypto.subtle.generateKey(
		{
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256'
		},
		true,
		['sign', 'verify']
	);
	const tKey = Date.now();

	// 2) JWK export (JWKS 엔드포인트에서 그대로 쓸 형태)
	const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
	const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

	// 3) JWT 직접 조립 (header.payload.signature)
	const b64url = (bytes: Uint8Array | string) => {
		const bin = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
		return btoa(String.fromCharCode(...bin))
			.replace(/=+$/, '')
			.replace(/\+/g, '-')
			.replace(/\//g, '_');
	};
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'poc-1' }));
	const payload = b64url(
		JSON.stringify({
			iss: 'https://idp.example',
			sub: 'user-123',
			aud: 'client-abc',
			exp: Math.floor(Date.now() / 1000) + 600,
			iat: Math.floor(Date.now() / 1000)
		})
	);
	const signingInput = `${header}.${payload}`;
	const sigBytes = new Uint8Array(
		await crypto.subtle.sign(
			{ name: 'RSASSA-PKCS1-v1_5' },
			keyPair.privateKey,
			new TextEncoder().encode(signingInput)
		)
	);
	const jwt = `${signingInput}.${b64url(sigBytes)}`;
	const tSign = Date.now();

	// 4) 검증
	const ok = await crypto.subtle.verify(
		{ name: 'RSASSA-PKCS1-v1_5' },
		keyPair.publicKey,
		sigBytes,
		new TextEncoder().encode(signingInput)
	);
	const tVerify = Date.now();

	return json({
		ok,
		jwt,
		publicJwk,
		privateJwkPresent: !!privateJwk,
		timingMs: {
			keygen: tKey - t0,
			sign: tSign - tKey,
			verify: tVerify - tSign,
			total: tVerify - t0
		}
	});
};

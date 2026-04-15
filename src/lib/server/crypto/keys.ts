/**
 * M1 암호화 primitives
 *
 * - RSA-2048 서명 키 생성 (RSASSA-PKCS1-v1_5 / SHA-256)
 * - AES-256-GCM 를 이용한 private JWK 래핑/언래핑 (HKDF from IDP_SIGNING_KEY_SECRET)
 * - RS256 ID Token 서명 (signJwt)
 * - HMAC-SHA256 opaque 액세스 토큰 (generateAccessToken / verifyAccessToken)
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { signingKeys } from '$lib/server/db/schema';

// ── base64url helpers ─────────────────────────────────────────────────────────

export function b64uEncode(input: ArrayBuffer | Uint8Array): string {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

export function b64uDecode(str: string): Uint8Array<ArrayBuffer> {
	const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64);
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}

// ── private key wrapping ──────────────────────────────────────────────────────

async function deriveWrappingKey(secret: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	const enc = new TextEncoder();
	const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, [
		'deriveKey'
	]);
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('idp-signing-key-wrap-v1') },
		keyMaterial,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

/**
 * private key JWK 를 AES-256-GCM 으로 암호화.
 * 반환 형식: `<salt_b64u>.<iv_b64u>.<ciphertext_b64u>`
 */
export async function wrapPrivateKey(privateKey: CryptoKey, secret: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const wrappingKey = await deriveWrappingKey(secret, salt);
	const jwk = await crypto.subtle.exportKey('jwk', privateKey);
	const enc = new TextEncoder();
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		wrappingKey,
		enc.encode(JSON.stringify(jwk))
	);
	return `${b64uEncode(salt)}.${b64uEncode(iv)}.${b64uEncode(ciphertext)}`;
}

/**
 * `wrapPrivateKey` 역연산. 복호화된 JWK 를 RS256 서명용 CryptoKey 로 반환.
 */
export async function unwrapPrivateKey(encrypted: string, secret: string): Promise<CryptoKey> {
	const parts = encrypted.split('.');
	if (parts.length !== 3) throw new Error('Invalid encrypted key format');
	const [saltB64, ivB64, ctB64] = parts;
	const wrappingKey = await deriveWrappingKey(secret, b64uDecode(saltB64));
	const dec = new TextDecoder();
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: b64uDecode(ivB64) },
		wrappingKey,
		b64uDecode(ctB64)
	);
	const jwk = JSON.parse(dec.decode(plaintext)) as JsonWebKey;
	return crypto.subtle.importKey(
		'jwk',
		jwk,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign']
	);
}

// ── key generation ────────────────────────────────────────────────────────────

export async function generateRsaSigningKey(): Promise<{
	kid: string;
	publicKey: CryptoKey;
	privateKey: CryptoKey;
	publicJwk: JsonWebKey;
}> {
	const kid = crypto.randomUUID();
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
	const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
	return { kid, publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, publicJwk };
}

// ── JWT signing (RS256) ───────────────────────────────────────────────────────

export async function signJwt(
	payload: Record<string, unknown>,
	privateKey: CryptoKey,
	kid: string
): Promise<string> {
	const enc = new TextEncoder();
	const header = { alg: 'RS256', typ: 'JWT', kid };
	const headerB64 = b64uEncode(enc.encode(JSON.stringify(header)));
	const payloadB64 = b64uEncode(enc.encode(JSON.stringify(payload)));
	const signingInput = `${headerB64}.${payloadB64}`;
	const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, enc.encode(signingInput));
	return `${signingInput}.${b64uEncode(sig)}`;
}

// ── opaque access token (HMAC-SHA256) ─────────────────────────────────────────

export interface AccessTokenClaims {
	sub: string;
	tenantId: string;
	clientId: string;
	scope: string;
	exp: number;
	iat: number;
}

async function deriveHmacKey(secret: string): Promise<CryptoKey> {
	const enc = new TextEncoder();
	return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
}

export async function generateAccessToken(
	claims: AccessTokenClaims,
	secret: string
): Promise<string> {
	const enc = new TextEncoder();
	const data = b64uEncode(enc.encode(JSON.stringify(claims)));
	const key = await deriveHmacKey(secret);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
	return `${data}.${b64uEncode(sig)}`;
}

export async function verifyAccessToken(
	token: string,
	secret: string
): Promise<AccessTokenClaims | null> {
	try {
		const lastDot = token.lastIndexOf('.');
		if (lastDot === -1) return null;
		const data = token.slice(0, lastDot);
		const sigB64 = token.slice(lastDot + 1);
		const enc = new TextEncoder();
		const key = await deriveHmacKey(secret);
		const valid = await crypto.subtle.verify('HMAC', key, b64uDecode(sigB64), enc.encode(data));
		if (!valid) return null;
		const dec = new TextDecoder();
		const claims = JSON.parse(dec.decode(b64uDecode(data))) as AccessTokenClaims;
		if (claims.exp < Math.floor(Date.now() / 1000)) return null;
		return claims;
	} catch {
		return null;
	}
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function getActiveSigningKey(
	db: DB,
	tenantId: string,
	secret: string
): Promise<{ kid: string; privateKey: CryptoKey; publicJwk: JsonWebKey } | null> {
	const [row] = await db
		.select()
		.from(signingKeys)
		.where(
			and(
				eq(signingKeys.tenantId, tenantId),
				eq(signingKeys.active, true),
				isNull(signingKeys.rotatedAt)
			)
		)
		.limit(1);
	if (!row) return null;
	const privateKey = await unwrapPrivateKey(row.privateJwkEncrypted, secret);
	return { kid: row.kid, privateKey, publicJwk: JSON.parse(row.publicJwk) as JsonWebKey };
}

export async function getPublicJwks(
	db: DB,
	tenantId: string
): Promise<Array<Record<string, unknown>>> {
	const rows = await db
		.select({
			kid: signingKeys.kid,
			use: signingKeys.use,
			alg: signingKeys.alg,
			publicJwk: signingKeys.publicJwk
		})
		.from(signingKeys)
		.where(eq(signingKeys.tenantId, tenantId));
	return rows.map((r) => ({
		...(JSON.parse(r.publicJwk) as Record<string, unknown>),
		kid: r.kid,
		use: r.use,
		alg: r.alg
	}));
}

/**
 * WebAuthn / Passkey 구현 (M3.5)
 *
 * - 등록/인증 챌린지를 HMAC-서명 쿠키로 단기 저장 (5분 TTL)
 * - @simplewebauthn/server v13, Workers WebCrypto 전용
 * - residentKey: 'required' → username-less(discoverable) 로그인 지원
 */

import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse
} from '@simplewebauthn/server';
import type {
	AuthenticatorTransportFuture,
	AuthenticationResponseJSON,
	RegistrationResponseJSON
} from '@simplewebauthn/server';
import type { DB } from '$lib/server/db';
import { credentials } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';

export const WEBAUTHN_CHALLENGE_COOKIE = 'idp_webauthn_challenge';
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5분

// ── b64u 헬퍼 ─────────────────────────────────────────────────────────────────

function b64uEncode(buf: Uint8Array): string {
	return btoa(String.fromCharCode(...buf))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function b64uDecode(s: string): Uint8Array<ArrayBuffer> {
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64);
	const arr = new Uint8Array(bin.length) as Uint8Array<ArrayBuffer>;
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}

// ── Challenge cookie ──────────────────────────────────────────────────────────

interface ChallengeCookiePayload {
	challenge: string; // base64url
	type: 'register' | 'authenticate';
	userId?: string; // register 시에만 세팅
	exp: number;
}

async function importHmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		[usage]
	);
}

export async function createChallengeCookie(
	payload: Omit<ChallengeCookiePayload, 'exp'>,
	signingKeySecret: string
): Promise<string> {
	const enc = new TextEncoder();
	const full: ChallengeCookiePayload = { ...payload, exp: Date.now() + CHALLENGE_TTL_MS };
	const data = b64uEncode(enc.encode(JSON.stringify(full)));
	const key = await importHmacKey(signingKeySecret, 'sign');
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
	return `${data}.${b64uEncode(new Uint8Array(sig))}`;
}

export async function verifyChallengeCookie(
	token: string,
	signingKeySecret: string,
	expectedType: 'register' | 'authenticate'
): Promise<ChallengeCookiePayload | null> {
	try {
		const lastDot = token.lastIndexOf('.');
		if (lastDot === -1) return null;
		const data = token.slice(0, lastDot);
		const sigPart = token.slice(lastDot + 1);
		const enc = new TextEncoder();
		const key = await importHmacKey(signingKeySecret, 'verify');
		const valid = await crypto.subtle.verify('HMAC', key, b64uDecode(sigPart), enc.encode(data));
		if (!valid) return null;
		const payload = JSON.parse(
			new TextDecoder().decode(b64uDecode(data))
		) as ChallengeCookiePayload;
		if (payload.exp < Date.now()) return null;
		if (payload.type !== expectedType) return null;
		return payload;
	} catch {
		return null;
	}
}

// ── RP 설정 ────────────────────────────────────────────────────────────────────

export function getWebAuthnConfig(url: URL) {
	return {
		rpID: url.hostname,
		rpName: 'IdP',
		origin: url.origin
	};
}

// ── 등록 (Registration) ────────────────────────────────────────────────────────

export async function buildRegistrationOptions(
	db: DB,
	userId: string,
	userEmail: string,
	userDisplayName: string | null,
	rpID: string,
	rpName: string
) {
	// 이미 등록된 passkeys → excludeCredentials 에 포함(중복 방지)
	const existing = await db
		.select({ credentialId: credentials.credentialId })
		.from(credentials)
		.where(and(eq(credentials.userId, userId), eq(credentials.type, 'webauthn')));

	const excludeCredentials = existing
		.filter((c) => c.credentialId !== null)
		.map((c) => ({ id: c.credentialId! }));

	return generateRegistrationOptions({
		rpID,
		rpName,
		userName: userEmail,
		userDisplayName: userDisplayName || userEmail,
		userID: new TextEncoder().encode(userId) as Uint8Array<ArrayBuffer>,
		attestationType: 'none',
		authenticatorSelection: {
			residentKey: 'required',
			userVerification: 'required'
		},
		excludeCredentials
	});
}

export async function savePasskey(
	db: DB,
	userId: string,
	label: string,
	verificationResult: Awaited<ReturnType<typeof verifyRegistrationResponse>>
): Promise<void> {
	const info = verificationResult.registrationInfo;
	if (!info) throw new Error('registrationInfo 가 없습니다');
	const { credential } = info;
	await db.insert(credentials).values({
		id: crypto.randomUUID(),
		userId,
		type: 'webauthn',
		label: label || '패스키',
		credentialId: credential.id,
		publicKey: b64uEncode(new Uint8Array(credential.publicKey)),
		counter: credential.counter,
		transports: credential.transports ? JSON.stringify(credential.transports) : null
	});
}

// ── 인증 (Authentication) ──────────────────────────────────────────────────────

export async function buildAuthenticationOptions(rpID: string) {
	return generateAuthenticationOptions({
		rpID,
		userVerification: 'required'
		// allowCredentials 미지정 → discoverable credential (username-less)
	});
}

export interface PasskeyVerifyResult {
	userId: string;
	credentialDbId: string;
	newCounter: number;
}

export async function verifyPasskeyAuthentication(
	db: DB,
	response: AuthenticationResponseJSON,
	expectedChallenge: string,
	rpID: string,
	origin: string
): Promise<PasskeyVerifyResult | null> {
	const credentialId = response.id;

	const [cred] = await db
		.select()
		.from(credentials)
		.where(and(eq(credentials.credentialId, credentialId), eq(credentials.type, 'webauthn')))
		.limit(1);

	if (!cred || !cred.publicKey) return null;

	const publicKey = b64uDecode(cred.publicKey);
	const transports = cred.transports
		? (JSON.parse(cred.transports) as AuthenticatorTransportFuture[])
		: undefined;

	const verification = await verifyAuthenticationResponse({
		response,
		expectedChallenge,
		expectedOrigin: origin,
		expectedRPID: rpID,
		credential: {
			id: credentialId,
			publicKey,
			counter: cred.counter,
			transports
		}
	});

	if (!verification.verified) return null;

	const newCounter = verification.authenticationInfo.newCounter;
	await db
		.update(credentials)
		.set({ counter: newCounter, lastUsedAt: new Date() })
		.where(eq(credentials.id, cred.id));

	return { userId: cred.userId, credentialDbId: cred.id, newCounter };
}

// ── verifyRegistrationResponse 재익스포트 (API 라우트에서 사용) ──────────────────

export { verifyRegistrationResponse };
export type { RegistrationResponseJSON, AuthenticationResponseJSON };

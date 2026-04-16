/**
 * MFA pending 상태 관리.
 *
 * 비밀번호 인증 성공 후 TOTP 단계가 남아있을 때, 단기(5분) HMAC-서명 쿠키로
 * { userId, tenantId, redirectTo } 를 안전하게 전달한다.
 *
 * 형식: `<payload_b64u>.<signature_b64u>`
 * payload JSON: { uid, tid, redir, exp }
 */

export const MFA_PENDING_COOKIE = 'idp_mfa_pending';
const MFA_PENDING_TTL_MS = 5 * 60 * 1000; // 5분

export interface MfaPendingClaims {
	userId: string;
	tenantId: string;
	redirectTo: string | null;
}

interface MfaPendingPayload {
	uid: string;
	tid: string;
	redir: string | null;
	exp: number;
}

function b64uEncode(input: Uint8Array): string {
	return btoa(String.fromCharCode(...input))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function b64uDecode(str: string): Uint8Array<ArrayBuffer> {
	const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64);
	const arr = new Uint8Array(bin.length) as Uint8Array<ArrayBuffer>;
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}

async function deriveHmacKey(secret: string): Promise<CryptoKey> {
	const enc = new TextEncoder();
	return crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify']
	);
}

/**
 * MFA pending 토큰 생성. 쿠키 value 로 사용한다.
 */
export async function createMfaPendingToken(
	claims: MfaPendingClaims,
	signingKeySecret: string
): Promise<string> {
	const enc = new TextEncoder();
	const payload: MfaPendingPayload = {
		uid: claims.userId,
		tid: claims.tenantId,
		redir: claims.redirectTo,
		exp: Date.now() + MFA_PENDING_TTL_MS
	};
	const data = b64uEncode(enc.encode(JSON.stringify(payload)));
	const key = await deriveHmacKey(signingKeySecret);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
	return `${data}.${b64uEncode(new Uint8Array(sig))}`;
}

/**
 * MFA pending 토큰을 검증하고 claims 를 반환한다.
 * 만료되었거나 서명이 유효하지 않으면 null 반환.
 */
export async function verifyMfaPendingToken(
	token: string,
	signingKeySecret: string
): Promise<MfaPendingClaims | null> {
	try {
		const lastDot = token.lastIndexOf('.');
		if (lastDot === -1) return null;
		const data = token.slice(0, lastDot);
		const sigB64 = token.slice(lastDot + 1);
		const enc = new TextEncoder();
		const key = await deriveHmacKey(signingKeySecret);
		const valid = await crypto.subtle.verify('HMAC', key, b64uDecode(sigB64), enc.encode(data));
		if (!valid) return null;
		const payload = JSON.parse(new TextDecoder().decode(b64uDecode(data))) as MfaPendingPayload;
		if (payload.exp < Date.now()) return null;
		return { userId: payload.uid, tenantId: payload.tid, redirectTo: payload.redir };
	} catch {
		return null;
	}
}

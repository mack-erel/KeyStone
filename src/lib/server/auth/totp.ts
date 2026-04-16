/**
 * TOTP (RFC 6238) + 백업 코드 구현.
 *
 * - TOTP: WebCrypto HMAC-SHA-1, 30초 스텝, 6자리, ±1 윈도우
 * - 시크릿 암호화: AES-256-GCM + HKDF (IDP_SIGNING_KEY_SECRET 재사용)
 * - 백업 코드: 10개 × 8자리 alphanumeric, SHA-256 단방향 해시
 */

// ── Base32 (RFC 4648) ─────────────────────────────────────────────────────────

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_MAP: Record<string, number> = {};
for (let i = 0; i < BASE32_CHARS.length; i++) BASE32_MAP[BASE32_CHARS[i]] = i;

export function base32Encode(input: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let output = '';
	for (const byte of input) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		output += BASE32_CHARS[(value << (5 - bits)) & 31];
	}
	return output;
}

export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
	const normalized = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
	let bits = 0;
	let value = 0;
	const output: number[] = [];
	for (const ch of normalized) {
		const v = BASE32_MAP[ch];
		if (v === undefined) continue;
		value = (value << 5) | v;
		bits += 5;
		if (bits >= 8) {
			output.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return new Uint8Array(output) as Uint8Array<ArrayBuffer>;
}

// ── HOTP / TOTP ───────────────────────────────────────────────────────────────

async function hotp(key: Uint8Array<ArrayBuffer>, counter: number): Promise<number> {
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		key,
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	);
	const counterBuf = new Uint8Array(8);
	// counter를 빅엔디안 8바이트로 기록
	let c = counter;
	for (let i = 7; i >= 0; i--) {
		counterBuf[i] = c & 0xff;
		c = Math.floor(c / 256);
	}
	const sig = await crypto.subtle.sign('HMAC', cryptoKey, counterBuf);
	const hash = new Uint8Array(sig);
	const offset = hash[19] & 0xf;
	const code =
		((hash[offset] & 0x7f) << 24) |
		(hash[offset + 1] << 16) |
		(hash[offset + 2] << 8) |
		hash[offset + 3];
	return code % 1_000_000;
}

/**
 * TOTP 코드를 생성한다 (검증 테스트·시드 등록 확인용).
 */
export async function generateTotpCode(base32Secret: string, stepOffset = 0): Promise<string> {
	const key = base32Decode(base32Secret);
	const step = Math.floor(Date.now() / 30_000) + stepOffset;
	const code = await hotp(key, step);
	return String(code).padStart(6, '0');
}

/**
 * TOTP 코드를 검증한다. 시간 드리프트를 고려해 ±1 윈도우(±30초)를 허용한다.
 */
export async function verifyTotp(code: string, base32Secret: string): Promise<boolean> {
	if (!/^\d{6}$/.test(code)) return false;
	const key = base32Decode(base32Secret);
	const t = Math.floor(Date.now() / 30_000);
	for (const offset of [-1, 0, 1]) {
		const expected = await hotp(key, t + offset);
		if (String(expected).padStart(6, '0') === code) return true;
	}
	return false;
}

// ── TOTP 시크릿 암호화/복호화 ──────────────────────────────────────────────────

async function deriveTotpWrapKey(signingKeySecret: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	const enc = new TextEncoder();
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		enc.encode(signingKeySecret),
		'HKDF',
		false,
		['deriveKey']
	);
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('idp-totp-secret-wrap-v1') },
		keyMaterial,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

/**
 * TOTP base32 시크릿을 AES-256-GCM 으로 암호화한다.
 * 형식: `<salt_b64u>.<iv_b64u>.<ciphertext_b64u>`
 */
export async function encryptTotpSecret(base32Secret: string, signingKeySecret: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const wrapKey = await deriveTotpWrapKey(signingKeySecret, salt);
	const enc = new TextEncoder();
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, enc.encode(base32Secret));
	const b64u = (buf: Uint8Array) =>
		btoa(String.fromCharCode(...buf))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	return `${b64u(salt)}.${b64u(iv)}.${b64u(new Uint8Array(ct))}`;
}

/**
 * `encryptTotpSecret` 역연산. 복호화된 base32 시크릿 반환.
 */
export async function decryptTotpSecret(encrypted: string, signingKeySecret: string): Promise<string> {
	const parts = encrypted.split('.');
	if (parts.length !== 3) throw new Error('Invalid encrypted TOTP secret format');
	const [saltB64, ivB64, ctB64] = parts;
	const b64uDec = (s: string): Uint8Array<ArrayBuffer> => {
		const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
		const bin = atob(b64);
		const arr = new Uint8Array(bin.length) as Uint8Array<ArrayBuffer>;
		for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
		return arr;
	};
	const wrapKey = await deriveTotpWrapKey(signingKeySecret, b64uDec(saltB64));
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: b64uDec(ivB64) },
		wrapKey,
		b64uDec(ctB64)
	);
	return new TextDecoder().decode(plaintext);
}

// ── OTP Auth URI ───────────────────────────────────────────────────────────────

/**
 * otpauth:// URI 생성 (QR 코드 소스로 사용).
 */
export function buildOtpAuthUri(base32Secret: string, username: string, issuer: string): string {
	const label = encodeURIComponent(`${issuer}:${username}`);
	const params = new URLSearchParams({
		secret: base32Secret,
		issuer,
		algorithm: 'SHA1',
		digits: '6',
		period: '30'
	});
	return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * 새 TOTP base32 시크릿을 생성한다 (20 바이트 = 160 bit).
 */
export function generateTotpSecret(): string {
	return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

// ── 백업 코드 ─────────────────────────────────────────────────────────────────

const BACKUP_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 혼동 문자 제외

function randomBackupCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (b) => BACKUP_CODE_CHARS[b % BACKUP_CODE_CHARS.length]).join('');
}

/**
 * 백업 코드 10개를 생성한다 (일회성, 화면 표시 후 해시만 저장).
 */
export function generateBackupCodes(): string[] {
	return Array.from({ length: 10 }, () => randomBackupCode());
}

/**
 * 백업 코드를 SHA-256 해시로 저장용 변환.
 * 코드 자체가 충분한 엔트로피를 가지므로 salt 없이 사용.
 */
export async function hashBackupCode(code: string): Promise<string> {
	const enc = new TextEncoder();
	const digest = await crypto.subtle.digest('SHA-256', enc.encode(code.toUpperCase()));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 입력한 코드가 저장된 해시와 일치하는지 검증.
 */
export async function verifyBackupCode(code: string, storedHash: string): Promise<boolean> {
	const hash = await hashBackupCode(code);
	return hash === storedHash;
}

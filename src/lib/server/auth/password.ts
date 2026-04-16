/**
 * 패스워드 해싱 유틸리티
 *
 * - 신규 해시: argon2id (hash-wasm)
 * - 레거시 해시: pbkdf2$sha256:100000 — 로그인 성공 시 argon2id 로 자동 업그레이드
 *
 * 포맷
 *   argon2id: argon2id$m=65536,t=3,p=4$<salt_b64>$<hash_b64>
 *   pbkdf2:   pbkdf2$sha256:100000$<salt_b64>$<hash_b64>
 */

import { argon2id } from 'hash-wasm';

// argon2id 파라미터 (OWASP 권장: m=64MiB, t=3, p=4)
const ARGON2_MEMORY_KIB = 65536; // 64 MiB
const ARGON2_ITERATIONS = 3;
const ARGON2_PARALLELISM = 4;
const ARGON2_HASH_LENGTH = 32;
const ARGON2_SALT_LENGTH = 16;

// 레거시 PBKDF2 파라미터
const PBKDF2_DIGEST = 'sha256';
const PBKDF2_ITERATIONS = 100_000;

// ── 공통 헬퍼 ────────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
	return diff === 0;
}

// ── argon2id ─────────────────────────────────────────────────────────────────

async function hashArgon2id(password: string, salt: Uint8Array): Promise<Uint8Array> {
	const result = await argon2id({
		password,
		salt,
		iterations: ARGON2_ITERATIONS,
		memorySize: ARGON2_MEMORY_KIB,
		parallelism: ARGON2_PARALLELISM,
		hashLength: ARGON2_HASH_LENGTH,
		outputType: 'binary'
	});
	return result;
}

function formatArgon2id(salt: Uint8Array, hash: Uint8Array): string {
	return `argon2id$m=${ARGON2_MEMORY_KIB},t=${ARGON2_ITERATIONS},p=${ARGON2_PARALLELISM}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

function parseArgon2id(record: string) {
	// argon2id$m=65536,t=3,p=4$<salt_b64>$<hash_b64>
	const parts = record.split('$');
	if (parts.length !== 4 || parts[0] !== 'argon2id') return null;

	const params = Object.fromEntries(
		(parts[1] ?? '').split(',').map((p) => {
			const [k, v] = p.split('=');
			return [k, Number(v)];
		})
	);

	const saltB64 = parts[2];
	const hashB64 = parts[3];
	if (!saltB64 || !hashB64) return null;

	return {
		memorySize: params.m ?? ARGON2_MEMORY_KIB,
		iterations: params.t ?? ARGON2_ITERATIONS,
		parallelism: params.p ?? ARGON2_PARALLELISM,
		salt: base64ToBytes(saltB64),
		hash: base64ToBytes(hashB64)
	};
}

// ── 레거시 PBKDF2 ─────────────────────────────────────────────────────────────

async function derivePbkdf2(
	password: string,
	salt: Uint8Array,
	iterations: number
): Promise<Uint8Array> {
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		{ name: 'PBKDF2' },
		false,
		['deriveBits']
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt).buffer, iterations },
		keyMaterial,
		256
	);
	return new Uint8Array(bits);
}

function parsePbkdf2(record: string) {
	// pbkdf2$sha256:100000$<salt_b64>$<hash_b64>
	const parts = record.split('$');
	if (parts.length !== 4 || parts[0] !== 'pbkdf2') return null;

	const [digest, iterStr] = (parts[1] ?? '').split(':');
	const iterations = Number(iterStr);

	const saltB64 = parts[2];
	const hashB64 = parts[3];

	if (digest !== PBKDF2_DIGEST || !Number.isFinite(iterations) || !saltB64 || !hashB64) {
		return null;
	}

	return { iterations, salt: base64ToBytes(saltB64), hash: base64ToBytes(hashB64) };
}

// ── 공개 API ─────────────────────────────────────────────────────────────────

/** 신규 패스워드를 argon2id 로 해싱한다. */
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(ARGON2_SALT_LENGTH));
	const hash = await hashArgon2id(password, salt);
	return formatArgon2id(salt, hash);
}

/**
 * 저장된 해시 레코드와 패스워드를 검증한다.
 *
 * - argon2id 레코드: 직접 검증
 * - pbkdf2 레코드: 검증 후 argon2id 로 업그레이드 (`rehash` 반환)
 */
export async function verifyPassword(
	password: string,
	record: string
): Promise<{ valid: boolean; rehash?: string }> {
	if (record.startsWith('argon2id$')) {
		const parsed = parseArgon2id(record);
		if (!parsed) return { valid: false };

		const candidate = await hashArgon2id(password, parsed.salt);

		// 파라미터가 현재 설정과 다르면 재해싱
		const paramsChanged =
			parsed.memorySize !== ARGON2_MEMORY_KIB ||
			parsed.iterations !== ARGON2_ITERATIONS ||
			parsed.parallelism !== ARGON2_PARALLELISM;

		if (!timingSafeEqual(candidate, parsed.hash)) return { valid: false };

		if (paramsChanged) {
			return { valid: true, rehash: await hashPassword(password) };
		}

		return { valid: true };
	}

	if (record.startsWith('pbkdf2$')) {
		const parsed = parsePbkdf2(record);
		if (!parsed) return { valid: false };

		const candidate = await derivePbkdf2(password, parsed.salt, parsed.iterations);
		if (!timingSafeEqual(candidate, parsed.hash)) return { valid: false };

		// 로그인 성공 → argon2id 로 자동 업그레이드
		return { valid: true, rehash: await hashPassword(password) };
	}

	return { valid: false };
}

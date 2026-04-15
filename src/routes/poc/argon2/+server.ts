import { json } from '@sveltejs/kit';

/**
 * PoC: 패스워드 해시 가능성 점검.
 *
 * Cloudflare Workers 제약:
 *  - Node crypto(bcrypt 네이티브) 미지원
 *  - WebAssembly 로드는 가능 (Wasm binding)
 *
 * 후보 라이브러리 (아직 설치하지 않음 — 사용자 승인 후):
 *  - `hash-wasm` (argon2id 포함, 단일 wasm, Workers 호환 리포트 있음)
 *  - `@node-rs/argon2` (NAPI/WASM, Workers 호환은 WASM 빌드 한정)
 *
 * 현재 코드: WebCrypto PBKDF2 를 fallback 으로 시연. 실서비스 해시로는 부적절하나
 * Workers 내부에서 SubtleCrypto 가 동작함을 확인하는 용도.
 *
 * GET /poc/argon2
 */
export const GET = async () => {
	const password = 'correct horse battery staple';
	const salt = crypto.getRandomValues(new Uint8Array(16));

	const t0 = Date.now();
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		{ name: 'PBKDF2' },
		false,
		['deriveBits']
	);
	const derived = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 },
		keyMaterial,
		256
	);
	const elapsed = Date.now() - t0;

	const b64 = (b: ArrayBuffer | Uint8Array) =>
		btoa(String.fromCharCode(...new Uint8Array(b)));

	return json({
		note: 'PBKDF2-SHA256 fallback. 프로덕션은 argon2id(hash-wasm) 전환 예정.',
		algorithm: 'PBKDF2-SHA256',
		iterations: 600000,
		salt_b64: b64(salt),
		hash_b64: b64(derived),
		elapsed_ms: elapsed,
		next_step: 'bun add hash-wasm 승인 후 argon2id 로 교체'
	});
};

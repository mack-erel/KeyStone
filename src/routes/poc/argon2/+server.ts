import { json } from '@sveltejs/kit';
import { hashPassword, verifyPassword } from '$lib/server/auth/password';

/**
 * PoC: 패스워드 해시 동작 확인.
 *
 * Cloudflare Workers 제약으로 hash-wasm(argon2id) 은 사용 불가:
 *  - Workers 는 WebAssembly.compile() 에 인라인 바이트를 전달하는 것을 금지
 *  - hash-wasm 은 이 방식으로 WASM 을 로드하므로 런타임 오류 발생
 *
 * 현재: PBKDF2-SHA256 100,000 회 (Workers WebCrypto 상한)
 *
 * GET /poc/argon2
 */
export const GET = async () => {
	const password = 'correct horse battery staple';

	const t0 = Date.now();
	const hash = await hashPassword(password);
	const hashElapsed = Date.now() - t0;

	const t1 = Date.now();
	const result = await verifyPassword(password, hash);
	const verifyElapsed = Date.now() - t1;

	const wrongResult = await verifyPassword('wrong password', hash);

	return json({
		algorithm: 'PBKDF2-SHA256',
		iterations: 100_000,
		note: 'Cloudflare Workers 제약으로 argon2id(hash-wasm) 사용 불가. WebAssembly.compile() 인라인 바이트 금지.',
		hash,
		hash_elapsed_ms: hashElapsed,
		verify_correct: result.valid,
		verify_elapsed_ms: verifyElapsed,
		verify_wrong: wrongResult.valid
	});
};

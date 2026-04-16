import { json } from '@sveltejs/kit';
import { hashPassword, verifyPassword } from '$lib/server/auth/password';

/**
 * PoC: argon2id (hash-wasm) 동작 확인.
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
		algorithm: 'argon2id',
		params: 'm=65536,t=3,p=4',
		hash,
		hash_elapsed_ms: hashElapsed,
		verify_correct: result.valid,
		verify_elapsed_ms: verifyElapsed,
		verify_wrong: wrongResult.valid
	});
};

import { b64uEncode } from '$lib/server/crypto/keys';

export async function verifyPkce(codeChallenge: string, codeChallengeMethod: string, codeVerifier: string): Promise<boolean> {
	if (codeChallengeMethod === 'S256') {
		const enc = new TextEncoder();
		const hash = await crypto.subtle.digest('SHA-256', enc.encode(codeVerifier));
		return b64uEncode(hash) === codeChallenge;
	}
	// plain 방식은 code_verifier 를 그대로 노출하므로 허용하지 않는다.
	return false;
}

import { b64uEncode } from '$lib/server/crypto/keys';

export async function verifyPkce(
	codeChallenge: string,
	codeChallengeMethod: string,
	codeVerifier: string
): Promise<boolean> {
	if (codeChallengeMethod === 'S256') {
		const enc = new TextEncoder();
		const hash = await crypto.subtle.digest('SHA-256', enc.encode(codeVerifier));
		return b64uEncode(hash) === codeChallenge;
	}
	if (codeChallengeMethod === 'plain') {
		return codeVerifier === codeChallenge;
	}
	return false;
}

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRuntimeConfig } from '$lib/server/auth/runtime';
import {
	buildAuthenticationOptions,
	createChallengeCookie,
	getWebAuthnConfig,
	WEBAUTHN_CHALLENGE_COOKIE
} from '$lib/server/auth/webauthn';

export const POST: RequestHandler = async ({ cookies, url, platform }) => {
	const config = getRuntimeConfig(platform);
	if (!config.signingKeySecret) {
		throw error(503, 'IDP_SIGNING_KEY_SECRET 이 설정되지 않았습니다.');
	}

	const { rpID, origin } = getWebAuthnConfig(url);

	const options = await buildAuthenticationOptions(rpID);

	const cookieValue = await createChallengeCookie(
		{ challenge: options.challenge, type: 'authenticate' },
		config.signingKeySecret
	);

	cookies.set(WEBAUTHN_CHALLENGE_COOKIE, cookieValue, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: origin.startsWith('https:'),
		maxAge: 5 * 60
	});

	return json(options);
};

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	const issuer = locals.runtimeConfig.issuerUrl ?? url.origin;

	return json(
		{
			issuer,
			authorization_endpoint: `${issuer}/oidc/authorize`,
			token_endpoint: `${issuer}/oidc/token`,
			userinfo_endpoint: `${issuer}/oidc/userinfo`,
			jwks_uri: `${issuer}/oidc/jwks`,
			end_session_endpoint: `${issuer}/oidc/end-session`,
			scopes_supported: ['openid', 'profile', 'email'],
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code'],
			subject_types_supported: ['public'],
			id_token_signing_alg_values_supported: ['RS256'],
			token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
			code_challenge_methods_supported: ['S256'],
			claims_supported: [
				'sub',
				'iss',
				'aud',
				'exp',
				'iat',
				'nonce',
				'sid',
				'email',
				'name',
				'preferred_username'
			]
		},
		{
			headers: {
				'Cache-Control': 'public, max-age=3600'
			}
		}
	);
};

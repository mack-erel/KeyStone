import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { requireDbContext } from '$lib/server/auth/guards';
import { users } from '$lib/server/db/schema';
import { verifyAccessToken } from '$lib/server/crypto/keys';

function bearerError(code: string, description: string): Response {
	return new Response(JSON.stringify({ error: code, error_description: description }), {
		status: 401,
		headers: {
			'Content-Type': 'application/json',
			'WWW-Authenticate': `Bearer error="${code}", error_description="${description}"`
		}
	});
}

async function handleUserinfo(locals: App.Locals, request: Request): Promise<Response> {
	const { db, tenant } = requireDbContext(locals);
	const { signingKeySecret } = locals.runtimeConfig;

	if (!signingKeySecret) {
		return new Response('IDP_SIGNING_KEY_SECRET 미설정', { status: 503 });
	}

	const authHeader = request.headers.get('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return bearerError('invalid_token', 'Bearer 토큰이 필요합니다.');
	}

	const token = authHeader.slice(7);
	const claims = await verifyAccessToken(token, signingKeySecret);

	if (!claims || claims.tenantId !== tenant.id) {
		return bearerError('invalid_token', '유효하지 않거나 만료된 액세스 토큰입니다.');
	}

	const [user] = await db
		.select()
		.from(users)
		.where(and(eq(users.id, claims.sub), eq(users.tenantId, tenant.id), eq(users.status, 'active')))
		.limit(1);

	if (!user) {
		return bearerError('invalid_token', '사용자를 찾을 수 없습니다.');
	}

	const response: Record<string, unknown> = { sub: user.id };

	if (claims.scope.split(' ').includes('email')) {
		response.email = user.email;
		if (user.emailVerifiedAt) response.email_verified = true;
	}

	if (claims.scope.split(' ').includes('profile')) {
		response.name = user.displayName;
		response.preferred_username = user.username ?? user.email.split('@')[0];
	}

	return json(response);
}

export const GET: RequestHandler = ({ locals, request }) => handleUserinfo(locals, request);
export const POST: RequestHandler = ({ locals, request }) => handleUserinfo(locals, request);

/**
 * SAML 2.0 Single Logout (SLO) 엔드포인트 — M2 최소 구현.
 *
 * GET /saml/slo
 *   - 현재 IdP 세션을 무효화하고 RelayState 또는 홈으로 리다이렉트.
 *   - LogoutRequest 파싱·서명 검증은 M3 에서 구현 예정.
 */

import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { requireDbContext } from '$lib/server/auth/guards';
import { sessions } from '$lib/server/db/schema';
import { recordAuditEvent, getRequestMetadata } from '$lib/server/audit';
import { SESSION_COOKIE_NAME } from '$lib/server/auth/constants';

export const GET: RequestHandler = async (event) => {
	const { locals, cookies } = event;
	const { db, tenant } = requireDbContext(locals);

	if (locals.session) {
		await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, locals.session.id));

		if (locals.user) {
			const requestMetadata = getRequestMetadata(event);
			await recordAuditEvent(db, {
				tenantId: tenant.id,
				userId: locals.user.id,
				actorId: locals.user.id,
				kind: 'saml_slo',
				outcome: 'success',
				ip: requestMetadata.ip,
				userAgent: requestMetadata.userAgent,
				detail: {},
			});
		}

		cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
	}

	throw redirect(302, '/');
};

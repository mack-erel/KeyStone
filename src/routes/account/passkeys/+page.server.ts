import { fail, redirect } from '@sveltejs/kit';
import { eq, and } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { recordAuditEvent, getRequestMetadata } from '$lib/server/audit/index';
import { credentials } from '$lib/server/db/schema';
import { WEBAUTHN_CREDENTIAL_TYPE } from '$lib/server/auth/constants';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(303, `/login?redirectTo=${encodeURIComponent(url.pathname)}`);
	}

	const { db } = requireDbContext(locals);

	const passkeys = await db
		.select({
			id: credentials.id,
			label: credentials.label,
			createdAt: credentials.createdAt,
			lastUsedAt: credentials.lastUsedAt,
			transports: credentials.transports
		})
		.from(credentials)
		.where(
			and(
				eq(credentials.userId, locals.user.id),
				eq(credentials.type, WEBAUTHN_CREDENTIAL_TYPE)
			)
		);

	return {
		passkeys,
		user: { email: locals.user.email, displayName: locals.user.displayName }
	};
};

export const actions: Actions = {
	delete: async (event) => {
		const { locals } = event;
		if (!locals.user) throw redirect(303, '/login');

		const formData = await event.request.formData();
		const credentialId = String(formData.get('id') ?? '').trim();
		if (!credentialId) {
			return fail(400, { error: '삭제할 패스키를 지정해 주세요.' });
		}

		const { db, tenant } = requireDbContext(locals);

		// 본인 소유 확인 후 삭제
		const deleted = await db
			.delete(credentials)
			.where(
				and(
					eq(credentials.id, credentialId),
					eq(credentials.userId, locals.user.id),
					eq(credentials.type, WEBAUTHN_CREDENTIAL_TYPE)
				)
			);

		if (!deleted) {
			return fail(404, { error: '패스키를 찾을 수 없습니다.' });
		}

		const requestMetadata = getRequestMetadata(event);
		await recordAuditEvent(db, {
			tenantId: tenant.id,
			userId: locals.user.id,
			actorId: locals.user.id,
			kind: 'passkey_deleted',
			outcome: 'success',
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent
		});

		return { deleted: true };
	}
};

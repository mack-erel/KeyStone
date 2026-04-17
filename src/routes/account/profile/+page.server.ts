import { fail, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { users } from '$lib/server/db/schema';
import { getUserMembership } from '$lib/server/org/membership';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const { db } = requireDbContext(locals);

	const membership = await getUserMembership(db, locals.user.id);

	return {
		profile: {
			displayName: locals.user.displayName,
			givenName: locals.user.givenName,
			familyName: locals.user.familyName,
			phoneNumber: locals.user.phoneNumber,
			avatarUrl: locals.user.avatarUrl,
			locale: locals.user.locale,
			zoneinfo: locals.user.zoneinfo,
			bio: locals.user.bio,
			birthdate: locals.user.birthdate,
		},
		membership,
	};
};

export const actions: Actions = {
	default: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/login');
		const { db, tenant } = requireDbContext(locals);

		const fd = await request.formData();
		const displayName = String(fd.get('displayName') ?? '').trim() || null;
		const givenName = String(fd.get('givenName') ?? '').trim() || null;
		const familyName = String(fd.get('familyName') ?? '').trim() || null;
		const phoneNumber = String(fd.get('phoneNumber') ?? '').trim() || null;
		const bio = String(fd.get('bio') ?? '').trim() || null;
		const birthdate = String(fd.get('birthdate') ?? '').trim() || null;
		const locale = String(fd.get('locale') ?? 'ko-KR').trim();
		const zoneinfo = String(fd.get('zoneinfo') ?? 'Asia/Seoul').trim();

		// birthdate 형식 검증 (YYYY-MM-DD)
		if (birthdate && !/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
			return fail(400, { error: '생년월일 형식이 올바르지 않습니다. (YYYY-MM-DD)' });
		}

		await db
			.update(users)
			.set({
				displayName,
				givenName,
				familyName,
				phoneNumber,
				bio,
				birthdate,
				locale,
				zoneinfo,
				updatedAt: new Date(),
			})
			.where(and(eq(users.id, locals.user.id), eq(users.tenantId, tenant.id)));

		return { success: true };
	},
};

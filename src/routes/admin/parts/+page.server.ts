import { fail } from '@sveltejs/kit';
import { asc, and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { departments, parts, teams } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const { db, tenant } = requireDbContext(locals);

	const rows = await db
		.select({
			id: parts.id,
			name: parts.name,
			code: parts.code,
			teamId: parts.teamId,
			teamName: teams.name,
			departmentName: departments.name,
			status: parts.status,
			createdAt: parts.createdAt
		})
		.from(parts)
		.leftJoin(teams, eq(parts.teamId, teams.id))
		.leftJoin(departments, eq(teams.departmentId, departments.id))
		.where(eq(parts.tenantId, tenant.id))
		.orderBy(asc(departments.name), asc(teams.name), asc(parts.name));

	// 팀 선택용 목록 (활성 팀만, 부서명 포함)
	const allTeams = await db
		.select({
			id: teams.id,
			name: teams.name,
			departmentName: departments.name
		})
		.from(teams)
		.leftJoin(departments, eq(teams.departmentId, departments.id))
		.where(and(eq(teams.tenantId, tenant.id), eq(teams.status, 'active')))
		.orderBy(asc(departments.name), asc(teams.name));

	return { parts: rows, allTeams };
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const { db, tenant } = requireDbContext(locals);
		const fd = await request.formData();
		const name = String(fd.get('name') ?? '').trim();
		const code = String(fd.get('code') ?? '').trim() || null;
		const teamId = String(fd.get('teamId') ?? '').trim() || null;
		const description = String(fd.get('description') ?? '').trim() || null;

		if (!name) return fail(400, { create: true, error: '파트명을 입력해 주세요.' });

		await db.insert(parts).values({
			tenantId: tenant.id,
			name,
			code,
			teamId,
			description
		});
		return { created: true };
	},

	update: async ({ locals, request }) => {
		const { db, tenant } = requireDbContext(locals);
		const fd = await request.formData();
		const id = String(fd.get('id') ?? '');
		const name = String(fd.get('name') ?? '').trim();
		const code = String(fd.get('code') ?? '').trim() || null;
		const teamId = String(fd.get('teamId') ?? '').trim() || null;
		const description = String(fd.get('description') ?? '').trim() || null;
		const status = String(fd.get('status') ?? 'active') as 'active' | 'inactive';

		if (!id || !name) return fail(400, { error: '잘못된 요청입니다.' });

		await db
			.update(parts)
			.set({ name, code, teamId, description, status, updatedAt: new Date() })
			.where(and(eq(parts.id, id), eq(parts.tenantId, tenant.id)));
		return { updated: true };
	},

	delete: async ({ locals, request }) => {
		const { db, tenant } = requireDbContext(locals);
		const fd = await request.formData();
		const id = String(fd.get('id') ?? '');
		if (!id) return fail(400, { error: '잘못된 요청입니다.' });

		await db
			.delete(parts)
			.where(and(eq(parts.id, id), eq(parts.tenantId, tenant.id)));
		return { deleted: true };
	}
};

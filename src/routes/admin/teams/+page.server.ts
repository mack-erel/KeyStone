import { fail } from '@sveltejs/kit';
import { asc, and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { departments, teams } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const { db, tenant } = requireDbContext(locals);

	const rows = await db
		.select({
			id: teams.id,
			name: teams.name,
			code: teams.code,
			departmentId: teams.departmentId,
			departmentName: departments.name,
			status: teams.status,
			createdAt: teams.createdAt
		})
		.from(teams)
		.leftJoin(departments, eq(teams.departmentId, departments.id))
		.where(eq(teams.tenantId, tenant.id))
		.orderBy(asc(departments.name), asc(teams.name));

	const allDepts = await db
		.select({ id: departments.id, name: departments.name })
		.from(departments)
		.where(and(eq(departments.tenantId, tenant.id), eq(departments.status, 'active')))
		.orderBy(asc(departments.name));

	return { teams: rows, allDepts };
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const { db, tenant } = requireDbContext(locals);
		const fd = await request.formData();
		const name = String(fd.get('name') ?? '').trim();
		const code = String(fd.get('code') ?? '').trim() || null;
		const departmentId = String(fd.get('departmentId') ?? '').trim() || null;
		const description = String(fd.get('description') ?? '').trim() || null;

		if (!name) return fail(400, { create: true, error: '팀명을 입력해 주세요.' });

		await db.insert(teams).values({
			tenantId: tenant.id,
			name,
			code,
			departmentId,
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
		const departmentId = String(fd.get('departmentId') ?? '').trim() || null;
		const description = String(fd.get('description') ?? '').trim() || null;
		const status = String(fd.get('status') ?? 'active') as 'active' | 'inactive';

		if (!id || !name) return fail(400, { error: '잘못된 요청입니다.' });

		await db
			.update(teams)
			.set({ name, code, departmentId, description, status, updatedAt: new Date() })
			.where(and(eq(teams.id, id), eq(teams.tenantId, tenant.id)));
		return { updated: true };
	},

	delete: async ({ locals, request }) => {
		const { db, tenant } = requireDbContext(locals);
		const fd = await request.formData();
		const id = String(fd.get('id') ?? '');
		if (!id) return fail(400, { error: '잘못된 요청입니다.' });

		await db
			.delete(teams)
			.where(and(eq(teams.id, id), eq(teams.tenantId, tenant.id)));
		return { deleted: true };
	}
};

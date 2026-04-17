import { fail } from '@sveltejs/kit';
import { asc, and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { departments } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const { db, tenant } = requireDbContext(locals);

	const rows = await db.select().from(departments).where(eq(departments.tenantId, tenant.id)).orderBy(asc(departments.displayOrder), asc(departments.name));

	// 부모 이름을 서버에서 매핑
	const nameById = new Map(rows.map((r) => [r.id, r.name]));
	const depts = rows.map((r) => ({
		...r,
		parentName: r.parentId ? (nameById.get(r.parentId) ?? null) : null,
	}));

	// 상위 부서 선택용 목록 (활성 부서만)
	const allDepts = rows.filter((r) => r.status === 'active').map((r) => ({ id: r.id, name: r.name }));

	return { departments: depts, allDepts };
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const { db, tenant } = requireDbContext(locals);
		const fd = await request.formData();
		const name = String(fd.get('name') ?? '').trim();
		const code = String(fd.get('code') ?? '').trim() || null;
		const parentId = String(fd.get('parentId') ?? '').trim() || null;
		const description = String(fd.get('description') ?? '').trim() || null;
		const displayOrder = parseInt(String(fd.get('displayOrder') ?? '0'), 10);

		if (!name) return fail(400, { create: true, error: '부서명을 입력해 주세요.' });

		await db.insert(departments).values({
			tenantId: tenant.id,
			name,
			code,
			parentId,
			description,
			displayOrder: isNaN(displayOrder) ? 0 : displayOrder,
		});
		return { created: true };
	},

	update: async ({ locals, request }) => {
		const { db, tenant } = requireDbContext(locals);
		const fd = await request.formData();
		const id = String(fd.get('id') ?? '');
		const name = String(fd.get('name') ?? '').trim();
		const code = String(fd.get('code') ?? '').trim() || null;
		const parentId = String(fd.get('parentId') ?? '').trim() || null;
		const description = String(fd.get('description') ?? '').trim() || null;
		const displayOrder = parseInt(String(fd.get('displayOrder') ?? '0'), 10);
		const status = String(fd.get('status') ?? 'active') as 'active' | 'inactive';

		if (!id || !name) return fail(400, { error: '잘못된 요청입니다.' });
		if (parentId === id) return fail(400, { error: '자기 자신을 상위 부서로 설정할 수 없습니다.' });

		await db
			.update(departments)
			.set({
				name,
				code,
				parentId,
				description,
				displayOrder: isNaN(displayOrder) ? 0 : displayOrder,
				status,
				updatedAt: new Date(),
			})
			.where(and(eq(departments.id, id), eq(departments.tenantId, tenant.id)));
		return { updated: true };
	},

	delete: async ({ locals, request }) => {
		const { db, tenant } = requireDbContext(locals);
		const fd = await request.formData();
		const id = String(fd.get('id') ?? '');
		if (!id) return fail(400, { error: '잘못된 요청입니다.' });

		await db.delete(departments).where(and(eq(departments.id, id), eq(departments.tenantId, tenant.id)));
		return { deleted: true };
	},
};

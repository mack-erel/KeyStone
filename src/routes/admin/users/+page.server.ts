import { fail, redirect } from '@sveltejs/kit';
import { desc, eq, and } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { recordAuditEvent, getRequestMetadata } from '$lib/server/audit/index';
import { users, credentials } from '$lib/server/db/schema';
import { hashPassword } from '$lib/server/auth/password';
import { normalizeEmail, normalizeUsername } from '$lib/server/auth/users';
import { PASSWORD_CREDENTIAL_TYPE } from '$lib/server/auth/constants';

export const load: PageServerLoad = async ({ locals }) => {
	const { db, tenant } = requireDbContext(locals);
	const rows = await db
		.select({
			id: users.id,
			username: users.username,
			email: users.email,
			displayName: users.displayName,
			role: users.role,
			status: users.status,
			createdAt: users.createdAt
		})
		.from(users)
		.where(eq(users.tenantId, tenant.id))
		.orderBy(desc(users.createdAt));

	return { users: rows };
};

export const actions: Actions = {
	// ── 사용자 생성 ────────────────────────────────────────────────────────────
	create: async (event) => {
		const { locals } = event;
		const { db, tenant } = requireDbContext(locals);

		const fd = await event.request.formData();
		const email = normalizeEmail(String(fd.get('email') ?? ''));
		const username = normalizeUsername(String(fd.get('username') ?? '')) || email.split('@')[0];
		const displayName = String(fd.get('displayName') ?? '').trim();
		const role = String(fd.get('role') ?? 'user') as 'admin' | 'user';
		const password = String(fd.get('password') ?? '');

		if (!email || !password) {
			return fail(400, { create: true, error: '이메일과 비밀번호는 필수입니다.' });
		}
		if (password.length < 8) {
			return fail(400, { create: true, error: '비밀번호는 8자 이상이어야 합니다.' });
		}
		if (!['admin', 'user'].includes(role)) {
			return fail(400, { create: true, error: '역할이 올바르지 않습니다.' });
		}

		// 중복 확인
		const [existing] = await db
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.tenantId, tenant.id), eq(users.email, email)))
			.limit(1);
		if (existing) {
			return fail(409, { create: true, error: '이미 사용 중인 이메일입니다.' });
		}

		const [existingUsername] = await db
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.tenantId, tenant.id), eq(users.username, username)))
			.limit(1);
		if (existingUsername) {
			return fail(409, { create: true, error: '이미 사용 중인 아이디입니다.' });
		}

		const userId = crypto.randomUUID();
		await db.insert(users).values({
			id: userId,
			tenantId: tenant.id,
			email,
			username,
			displayName: displayName || null,
			role,
			status: 'active'
		});

		const hashed = await hashPassword(password);
		await db.insert(credentials).values({
			id: crypto.randomUUID(),
			userId,
			type: PASSWORD_CREDENTIAL_TYPE,
			secret: hashed,
			label: '비밀번호'
		});

		const requestMetadata = getRequestMetadata(event);
		await recordAuditEvent(db, {
			tenantId: tenant.id,
			userId,
			actorId: locals.user!.id,
			kind: 'user_created',
			outcome: 'success',
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent,
			detail: { email, role }
		});

		return { create: true };
	},

	// ── 상태 변경 ─────────────────────────────────────────────────────────────
	updateStatus: async (event) => {
		const { locals } = event;
		const { db, tenant } = requireDbContext(locals);

		const fd = await event.request.formData();
		const id = String(fd.get('id') ?? '');
		const status = String(fd.get('status') ?? '') as 'active' | 'disabled' | 'locked';

		if (!id || !['active', 'disabled', 'locked'].includes(status)) {
			return fail(400, { error: '잘못된 요청입니다.' });
		}

		// 자기 자신 비활성화 방지
		if (id === locals.user!.id && status !== 'active') {
			return fail(400, { error: '자기 자신의 상태를 변경할 수 없습니다.' });
		}

		await db
			.update(users)
			.set({ status, updatedAt: new Date() })
			.where(and(eq(users.id, id), eq(users.tenantId, tenant.id)));

		const requestMetadata = getRequestMetadata(event);
		await recordAuditEvent(db, {
			tenantId: tenant.id,
			userId: id,
			actorId: locals.user!.id,
			kind: 'user_status_changed',
			outcome: 'success',
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent,
			detail: { status }
		});

		return { updateStatus: true };
	},

	// ── 역할 변경 ─────────────────────────────────────────────────────────────
	updateRole: async (event) => {
		const { locals } = event;
		const { db, tenant } = requireDbContext(locals);

		const fd = await event.request.formData();
		const id = String(fd.get('id') ?? '');
		const role = String(fd.get('role') ?? '') as 'admin' | 'user';

		if (!id || !['admin', 'user'].includes(role)) {
			return fail(400, { error: '잘못된 요청입니다.' });
		}

		// 자기 자신 역할 변경 방지
		if (id === locals.user!.id) {
			return fail(400, { error: '자기 자신의 역할을 변경할 수 없습니다.' });
		}

		await db
			.update(users)
			.set({ role, updatedAt: new Date() })
			.where(and(eq(users.id, id), eq(users.tenantId, tenant.id)));

		const requestMetadata = getRequestMetadata(event);
		await recordAuditEvent(db, {
			tenantId: tenant.id,
			userId: id,
			actorId: locals.user!.id,
			kind: 'user_role_changed',
			outcome: 'success',
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent,
			detail: { role }
		});

		return { updateRole: true };
	},

	// ── 비밀번호 초기화 ──────────────────────────────────────────────────────
	resetPassword: async (event) => {
		const { locals } = event;
		const { db, tenant } = requireDbContext(locals);

		const fd = await event.request.formData();
		const id = String(fd.get('id') ?? '');
		const newPassword = String(fd.get('newPassword') ?? '');

		if (!id || !newPassword) {
			return fail(400, { resetPassword: true, error: '비밀번호를 입력해 주세요.' });
		}
		if (newPassword.length < 8) {
			return fail(400, { resetPassword: true, error: '비밀번호는 8자 이상이어야 합니다.' });
		}

		// 대상 유저가 같은 테넌트인지 확인
		const [target] = await db
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.id, id), eq(users.tenantId, tenant.id)))
			.limit(1);
		if (!target) return fail(404, { resetPassword: true, error: '사용자를 찾을 수 없습니다.' });

		const hashed = await hashPassword(newPassword);
		const [existing] = await db
			.select({ id: credentials.id })
			.from(credentials)
			.where(and(eq(credentials.userId, id), eq(credentials.type, PASSWORD_CREDENTIAL_TYPE)))
			.limit(1);

		if (existing) {
			await db.update(credentials).set({ secret: hashed }).where(eq(credentials.id, existing.id));
		} else {
			await db.insert(credentials).values({
				id: crypto.randomUUID(),
				userId: id,
				type: PASSWORD_CREDENTIAL_TYPE,
				secret: hashed,
				label: '비밀번호'
			});
		}

		const requestMetadata = getRequestMetadata(event);
		await recordAuditEvent(db, {
			tenantId: tenant.id,
			userId: id,
			actorId: locals.user!.id,
			kind: 'password_reset',
			outcome: 'success',
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent
		});

		return { resetPassword: true };
	},

	// ── 삭제 ─────────────────────────────────────────────────────────────────
	delete: async (event) => {
		const { locals } = event;
		const { db, tenant } = requireDbContext(locals);

		const fd = await event.request.formData();
		const id = String(fd.get('id') ?? '');

		if (!id) return fail(400, { error: '잘못된 요청입니다.' });

		if (id === locals.user!.id) {
			return fail(400, { error: '자기 자신을 삭제할 수 없습니다.' });
		}

		await db.delete(users).where(and(eq(users.id, id), eq(users.tenantId, tenant.id)));

		const requestMetadata = getRequestMetadata(event);
		await recordAuditEvent(db, {
			tenantId: tenant.id,
			actorId: locals.user!.id,
			kind: 'user_deleted',
			outcome: 'success',
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent,
			detail: { userId: id }
		});

		return { deleted: true };
	}
};

import { and, eq } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { recordAuditEvent } from '$lib/server/audit';
import { credentials, identities, type Tenant, tenants, users } from '$lib/server/db/schema';
import {
	DEFAULT_TENANT_SLUG,
	LOCAL_IDENTITY_PROVIDER,
	PASSWORD_CREDENTIAL_TYPE
} from './constants';
import { hashPassword } from './password';
import { getRuntimeConfig } from './runtime';
import { findPasswordCredential, normalizeEmail, normalizeUsername } from './users';

function isUniqueConstraintError(error: unknown): boolean {
	return error instanceof Error && /unique constraint failed/i.test(error.message);
}

export async function ensureDefaultTenant(
	db: DB,
	platform: App.Platform | undefined
): Promise<Tenant> {
	const [existingTenant] = await db
		.select()
		.from(tenants)
		.where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
		.limit(1);

	if (existingTenant) {
		return existingTenant;
	}

	try {
		await db.insert(tenants).values({
			id: crypto.randomUUID(),
			slug: DEFAULT_TENANT_SLUG,
			name: getRuntimeConfig(platform).defaultTenantName,
			status: 'active'
		});
	} catch (error) {
		if (!isUniqueConstraintError(error)) {
			throw error;
		}
	}

	const [tenant] = await db
		.select()
		.from(tenants)
		.where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
		.limit(1);

	if (!tenant) {
		throw new Error('기본 tenant 를 초기화하지 못했습니다.');
	}

	return tenant;
}

async function ensureLocalIdentity(db: DB, tenantId: string, userId: string, email: string) {
	const [identity] = await db
		.select()
		.from(identities)
		.where(
			and(
				eq(identities.tenantId, tenantId),
				eq(identities.provider, LOCAL_IDENTITY_PROVIDER),
				eq(identities.subject, email)
			)
		)
		.limit(1);

	if (identity) {
		return;
	}

	await db.insert(identities).values({
		id: crypto.randomUUID(),
		tenantId,
		userId,
		provider: LOCAL_IDENTITY_PROVIDER,
		subject: email,
		email
	});
}

export async function ensureBootstrapAdmin(
	db: DB,
	platform: App.Platform | undefined,
	tenant: Tenant
) {
	const config = getRuntimeConfig(platform);

	if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) {
		return;
	}

	const email = normalizeEmail(config.bootstrapAdminEmail);
	const username = config.bootstrapAdminUsername
		? normalizeUsername(config.bootstrapAdminUsername)
		: email.split('@')[0];
	const [existingUser] = await db
		.select()
		.from(users)
		.where(and(eq(users.tenantId, tenant.id), eq(users.email, email)))
		.limit(1);

	if (existingUser) {
		const updates: Record<string, unknown> = {};
		if (existingUser.role !== 'admin') updates.role = 'admin';
		if (!existingUser.username) updates.username = username;
		if (Object.keys(updates).length > 0) {
			await db.update(users).set(updates).where(eq(users.id, existingUser.id));
		}

		const passwordCredential = await findPasswordCredential(db, existingUser.id);

		if (!passwordCredential) {
			await db.insert(credentials).values({
				id: crypto.randomUUID(),
				userId: existingUser.id,
				type: PASSWORD_CREDENTIAL_TYPE,
				secret: await hashPassword(config.bootstrapAdminPassword),
				label: 'Bootstrap password'
			});
		}

		await ensureLocalIdentity(db, tenant.id, existingUser.id, email);
		return;
	}

	const userId = crypto.randomUUID();
	await db.insert(users).values({
		id: userId,
		tenantId: tenant.id,
		email,
		username,
		displayName: config.bootstrapAdminName,
		role: 'admin',
		status: 'active'
	});

	await db.insert(credentials).values({
		id: crypto.randomUUID(),
		userId,
		type: PASSWORD_CREDENTIAL_TYPE,
		secret: await hashPassword(config.bootstrapAdminPassword),
		label: 'Bootstrap password'
	});

	await ensureLocalIdentity(db, tenant.id, userId, email);
	await recordAuditEvent(db, {
		tenantId: tenant.id,
		userId,
		actorId: 'system',
		kind: 'bootstrap_admin_seeded',
		outcome: 'success',
		detail: { email }
	});
}

export async function ensureAuthBaseline(db: DB, platform: App.Platform | undefined) {
	const tenant = await ensureDefaultTenant(db, platform);
	await ensureBootstrapAdmin(db, platform, tenant);
	return tenant;
}

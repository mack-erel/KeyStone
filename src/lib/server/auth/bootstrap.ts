import { and, eq } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { recordAuditEvent } from '$lib/server/audit';
import { credentials, identities, signingKeys, type Tenant, tenants, users } from '$lib/server/db/schema';
import {
	DEFAULT_TENANT_SLUG,
	LOCAL_IDENTITY_PROVIDER,
	PASSWORD_CREDENTIAL_TYPE
} from './constants';
import { hashPassword } from './password';
import { getRuntimeConfig } from './runtime';
import { findPasswordCredential, normalizeEmail, normalizeUsername } from './users';
import { generateRsaSigningKey, generateSelfSignedCert, unwrapPrivateKey, wrapPrivateKey } from '$lib/server/crypto/keys';

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

export async function ensureSigningKey(
	db: DB,
	tenant: Tenant,
	signingKeySecret: string,
	issuerUrl?: string
): Promise<void> {
	// SAML KeyDescriptor 용 CN
	let cn = 'idp';
	if (issuerUrl) {
		try {
			cn = new URL(issuerUrl).hostname;
		} catch {
			cn = issuerUrl;
		}
	}

	const [existing] = await db
		.select()
		.from(signingKeys)
		.where(and(eq(signingKeys.tenantId, tenant.id), eq(signingKeys.active, true)))
		.limit(1);

	// 키가 있지만 cert_pem 이 없는 경우 (M1 → M2 업그레이드): backfill
	if (existing) {
		if (!existing.certPem) {
			const privateKey = await unwrapPrivateKey(existing.privateJwkEncrypted, signingKeySecret);
			const publicJwk = JSON.parse(existing.publicJwk) as JsonWebKey;
			const publicKey = await crypto.subtle.importKey(
				'jwk',
				publicJwk,
				{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
				true,
				['verify']
			);
			const certPem = await generateSelfSignedCert(publicKey, privateKey, cn);
			await db.update(signingKeys).set({ certPem }).where(eq(signingKeys.id, existing.id));
		}
		return;
	}

	const { kid, publicKey, privateKey, publicJwk } = await generateRsaSigningKey();
	const privateJwkEncrypted = await wrapPrivateKey(privateKey, signingKeySecret);
	const certPem = await generateSelfSignedCert(publicKey, privateKey, cn);

	await db.insert(signingKeys).values({
		id: crypto.randomUUID(),
		tenantId: tenant.id,
		kid,
		use: 'sig',
		alg: 'RS256',
		publicJwk: JSON.stringify(publicJwk),
		privateJwkEncrypted,
		certPem,
		active: true
	});
}

export async function ensureAuthBaseline(db: DB, platform: App.Platform | undefined) {
	const config = getRuntimeConfig(platform);
	const tenant = await ensureDefaultTenant(db, platform);
	await ensureBootstrapAdmin(db, platform, tenant);
	if (config.signingKeySecret) {
		await ensureSigningKey(db, tenant, config.signingKeySecret, config.issuerUrl);
	}
	return tenant;
}

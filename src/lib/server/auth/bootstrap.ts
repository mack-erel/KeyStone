import { and, eq } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { signingKeys, type Tenant, tenants } from '$lib/server/db/schema';
import { DEFAULT_TENANT_SLUG } from './constants';
import { getRuntimeConfig } from './runtime';
import {
	generateRsaSigningKey,
	generateSelfSignedCert,
	unwrapPrivateKey,
	wrapPrivateKey
} from '$lib/server/crypto/keys';

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
	if (config.signingKeySecret) {
		await ensureSigningKey(db, tenant, config.signingKeySecret, config.issuerUrl);
	}
	return tenant;
}

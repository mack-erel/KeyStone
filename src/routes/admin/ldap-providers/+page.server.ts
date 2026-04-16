import { fail } from '@sveltejs/kit';
import { and, desc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { getRequestMetadata, recordAuditEvent } from '$lib/server/audit';
import { identityProviders } from '$lib/server/db/schema';
import type { LdapProviderConfig } from '$lib/server/ldap/types';

function buildConfig(fd: FormData): LdapProviderConfig {
	const port = parseInt(String(fd.get('port') ?? '389'), 10);
	const tlsMode = String(fd.get('tlsMode') ?? 'none') as 'none' | 'tls' | 'starttls';

	const bindDN = String(fd.get('bindDN') ?? '').trim();
	const bindPassword = String(fd.get('bindPassword') ?? '').trim();
	const userDnPattern = String(fd.get('userDnPattern') ?? '').trim();
	const userSearchFilter = String(fd.get('userSearchFilter') ?? '').trim();

	const config: LdapProviderConfig = {
		host: String(fd.get('host') ?? '').trim(),
		port: isNaN(port) ? 389 : port,
		baseDN: String(fd.get('baseDN') ?? '').trim(),
		tlsMode
	};

	if (bindDN) {
		config.bindDN = bindDN;
		if (bindPassword) config.bindPassword = bindPassword;
		if (userSearchFilter) config.userSearchFilter = userSearchFilter;
	} else if (userDnPattern) {
		config.userDnPattern = userDnPattern;
	}

	// 속성 매핑 — 기본값과 다를 때만 포함
	const email = String(fd.get('attrEmail') ?? '').trim();
	const displayName = String(fd.get('attrDisplayName') ?? '').trim();
	const givenName = String(fd.get('attrGivenName') ?? '').trim();
	const familyName = String(fd.get('attrFamilyName') ?? '').trim();

	if (email || displayName || givenName || familyName) {
		config.attributeMap = {};
		if (email) config.attributeMap.email = email;
		if (displayName) config.attributeMap.displayName = displayName;
		if (givenName) config.attributeMap.givenName = givenName;
		if (familyName) config.attributeMap.familyName = familyName;
	}

	return config;
}

export const load: PageServerLoad = async ({ locals }) => {
	const { db, tenant } = requireDbContext(locals);

	const rows = await db
		.select()
		.from(identityProviders)
		.where(and(eq(identityProviders.tenantId, tenant.id), eq(identityProviders.kind, 'ldap')))
		.orderBy(desc(identityProviders.createdAt));

	return { providers: rows };
};

export const actions: Actions = {
	create: async (event) => {
		const { db, tenant } = requireDbContext(event.locals);
		const fd = await event.request.formData();

		const name = String(fd.get('name') ?? '').trim();
		const host = String(fd.get('host') ?? '').trim();
		const hasBind = String(fd.get('bindDN') ?? '').trim();
		const hasPattern = String(fd.get('userDnPattern') ?? '').trim();

		if (!name) return fail(400, { create: true, error: '이름은 필수입니다.' });
		if (!host) return fail(400, { create: true, error: 'LDAP 호스트는 필수입니다.' });
		if (!hasBind && !hasPattern)
			return fail(400, {
				create: true,
				error: 'Admin Bind DN 또는 유저 DN 패턴 중 하나는 필수입니다.'
			});

		const config = buildConfig(fd);

		await db.insert(identityProviders).values({
			tenantId: tenant.id,
			kind: 'ldap',
			name,
			configJson: JSON.stringify(config),
			enabled: false
		});

		const meta = getRequestMetadata(event);
		await recordAuditEvent(db, {
			tenantId: tenant.id,
			actorId: event.locals.user!.id,
			kind: 'ldap_provider_created',
			outcome: 'success',
			ip: meta.ip,
			userAgent: meta.userAgent,
			detail: { name }
		});

		return { create: true };
	},

	update: async (event) => {
		const { db, tenant } = requireDbContext(event.locals);
		const fd = await event.request.formData();

		const id = String(fd.get('id') ?? '');
		const name = String(fd.get('name') ?? '').trim();
		const enabled = fd.get('enabled') === 'true';

		if (!id || !name) return fail(400, { error: '잘못된 요청입니다.' });

		const config = buildConfig(fd);

		await db
			.update(identityProviders)
			.set({ name, configJson: JSON.stringify(config), enabled, updatedAt: new Date() })
			.where(and(eq(identityProviders.id, id), eq(identityProviders.tenantId, tenant.id)));

		return { update: true };
	},

	delete: async (event) => {
		const { db, tenant } = requireDbContext(event.locals);
		const fd = await event.request.formData();
		const id = String(fd.get('id') ?? '');

		if (!id) return fail(400, { error: '잘못된 요청입니다.' });

		await db
			.delete(identityProviders)
			.where(and(eq(identityProviders.id, id), eq(identityProviders.tenantId, tenant.id)));

		const meta = getRequestMetadata(event);
		await recordAuditEvent(db, {
			tenantId: tenant.id,
			actorId: event.locals.user!.id,
			kind: 'ldap_provider_deleted',
			outcome: 'success',
			ip: meta.ip,
			userAgent: meta.userAgent,
			detail: { id }
		});

		return { deleted: true };
	}
};

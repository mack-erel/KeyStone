import { fail } from '@sveltejs/kit';
import { desc, eq, and, isNull } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireDbContext } from '$lib/server/auth/guards';
import { getRuntimeConfig } from '$lib/server/auth/runtime';
import { recordAuditEvent, getRequestMetadata } from '$lib/server/audit/index';
import { signingKeys } from '$lib/server/db/schema';
import {
	generateRsaSigningKey,
	wrapPrivateKey,
	generateSelfSignedCert
} from '$lib/server/crypto/keys';

export const load: PageServerLoad = async ({ locals }) => {
	const { db, tenant } = requireDbContext(locals);
	const rows = await db
		.select({
			id: signingKeys.id,
			kid: signingKeys.kid,
			alg: signingKeys.alg,
			use: signingKeys.use,
			active: signingKeys.active,
			hasCert: signingKeys.certPem,
			createdAt: signingKeys.createdAt,
			rotatedAt: signingKeys.rotatedAt,
			notAfter: signingKeys.notAfter
		})
		.from(signingKeys)
		.where(eq(signingKeys.tenantId, tenant.id))
		.orderBy(desc(signingKeys.createdAt));

	return {
		keys: rows.map((r) => ({ ...r, hasCert: r.hasCert !== null }))
	};
};

export const actions: Actions = {
	// ── 새 키 생성 + 기존 활성 키 rotate ──────────────────────────────────────
	rotate: async (event) => {
		const { locals, platform } = event;
		const { db, tenant } = requireDbContext(locals);

		const config = getRuntimeConfig(platform);
		if (!config.signingKeySecret) {
			return fail(503, { error: 'IDP_SIGNING_KEY_SECRET 이 설정되지 않았습니다.' });
		}

		const cn = config.issuerUrl ? new URL(config.issuerUrl).hostname : 'idp.local';

		// 기존 활성 키 비활성화
		await db
			.update(signingKeys)
			.set({ active: false, rotatedAt: new Date() })
			.where(
				and(
					eq(signingKeys.tenantId, tenant.id),
					eq(signingKeys.active, true),
					isNull(signingKeys.rotatedAt)
				)
			);

		// 새 키 생성
		const { kid, publicKey, privateKey, publicJwk } = await generateRsaSigningKey();
		const privateJwkEncrypted = await wrapPrivateKey(privateKey, config.signingKeySecret);
		const certPem = await generateSelfSignedCert(publicKey, privateKey, cn);

		await db.insert(signingKeys).values({
			id: crypto.randomUUID(),
			tenantId: tenant.id,
			kid,
			alg: 'RS256',
			publicJwk: JSON.stringify(publicJwk),
			privateJwkEncrypted,
			certPem,
			active: true
		});

		const requestMetadata = getRequestMetadata(event);
		await recordAuditEvent(db, {
			tenantId: tenant.id,
			actorId: locals.user!.id,
			kind: 'signing_key_rotated',
			outcome: 'success',
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent,
			detail: { newKid: kid }
		});

		return { rotated: true, newKid: kid };
	}
};

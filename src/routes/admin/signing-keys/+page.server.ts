import { fail } from "@sveltejs/kit";
import { desc, eq, and, isNull } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireAdminContext } from "$lib/server/auth/guards";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import { signingKeys } from "$lib/server/db/schema";
import { generateRsaSigningKey, wrapPrivateKey, generateSelfSignedCert } from "$lib/server/crypto/keys";

export const load: PageServerLoad = async ({ locals }) => {
    const { db, tenant } = requireAdminContext(locals);
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
            notAfter: signingKeys.notAfter,
        })
        .from(signingKeys)
        .where(eq(signingKeys.tenantId, tenant.id))
        .orderBy(desc(signingKeys.createdAt));

    return {
        keys: rows.map((r) => ({ ...r, hasCert: r.hasCert !== null })),
    };
};

export const actions: Actions = {
    // ── 새 키 생성 + 기존 활성 키 rotate ──────────────────────────────────────
    rotate: async (event) => {
        const { locals, platform } = event;
        const { db, tenant } = requireAdminContext(locals);

        const config = getRuntimeConfig(platform);
        if (!config.signingKeySecret) {
            return fail(503, { error: "IDP_SIGNING_KEY_SECRET 이 설정되지 않았습니다." });
        }

        const cn = config.issuerUrl ? new URL(config.issuerUrl).hostname : "idp.local";

        // 동시 rotate 방지 — 활성 키가 정확히 1개여야 한다.
        // (또 다른 rotate 가 진행 중이면 활성 키가 0개 또는 2개 이상이 된다.)
        const activeKeys = await db
            .select({ id: signingKeys.id })
            .from(signingKeys)
            .where(and(eq(signingKeys.tenantId, tenant.id), eq(signingKeys.active, true)));
        if (activeKeys.length > 1) {
            return fail(409, { error: "다른 rotate 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요." });
        }

        // 기존 활성 키 비활성화
        await db
            .update(signingKeys)
            .set({ active: false, rotatedAt: new Date() })
            .where(and(eq(signingKeys.tenantId, tenant.id), eq(signingKeys.active, true), isNull(signingKeys.rotatedAt)));

        // 새 키 생성 — 우선 inactive 로 INSERT 한 뒤 활성화
        const { kid, publicKey, privateKey, publicJwk } = await generateRsaSigningKey();
        const privateJwkEncrypted = await wrapPrivateKey(privateKey, config.signingKeySecret);
        const certPem = await generateSelfSignedCert(publicKey, privateKey, cn);

        const newId = crypto.randomUUID();
        await db.insert(signingKeys).values({
            id: newId,
            tenantId: tenant.id,
            kid,
            alg: "RS256",
            publicJwk: JSON.stringify(publicJwk),
            privateJwkEncrypted,
            certPem,
            active: false,
        });

        // 활성화 직전 다시 검사 — 동시에 rotate 가 활성화한 키가 있다면 실패 처리
        const stillActive = await db
            .select({ id: signingKeys.id })
            .from(signingKeys)
            .where(and(eq(signingKeys.tenantId, tenant.id), eq(signingKeys.active, true)));
        if (stillActive.length > 0) {
            // 우리가 만든 키는 active=false 로 남기고 fail 처리
            return fail(409, { error: "다른 rotate 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요." });
        }

        await db.update(signingKeys).set({ active: true }).where(eq(signingKeys.id, newId));

        const requestMetadata = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            kind: "signing_key_rotated",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            detail: { newKid: kid },
        });

        return { rotated: true, newKid: kid };
    },
};

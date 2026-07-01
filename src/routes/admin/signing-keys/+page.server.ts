import { fail } from "@sveltejs/kit";
import { desc, eq, and, isNull } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { type DB, DB_DIALECT } from "$lib/server/db";
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
    // ctrls H-ADMIN-5: rotate 를 atomic batch + partial unique index 기반으로 재설계.
    // 기존엔 SELECT → UPDATE → INSERT → SELECT → UPDATE 5단계가 분리되어 동시 rotate
    // 시 active 키 0/2개 race 가능했다.
    // 1. 새 키 자료 미리 생성 (CPU 집약적 작업은 트랜잭션 밖)
    // 2. db.batch([deactivate old, insert new as active=true]) 으로 원자 실행
    // 3. partial unique index (tenantId WHERE active=1) 가 DB 레벨에서 단일 active
    //    invariant 강제 — concurrent rotate 의 두 번째 INSERT 는 UNIQUE 위반으로
    //    자동 실패 (batch 전체 rollback).
    rotate: async (event) => {
        const { locals, platform } = event;
        const { db, tenant } = requireAdminContext(locals);

        const config = getRuntimeConfig(platform);
        if (!config.signingKeySecret) {
            return fail(503, { error: "IDP_SIGNING_KEY_SECRET 이 설정되지 않았습니다." });
        }

        const cn = config.issuerUrl ? new URL(config.issuerUrl).hostname : "idp.local";

        // 새 키 자료 생성 (트랜잭션 밖) — CPU/메모리 비용 큼.
        const { kid, publicKey, privateKey, publicJwk } = await generateRsaSigningKey();
        const privateJwkEncrypted = await wrapPrivateKey(privateKey, config.signingKeySecret);
        const certPem = await generateSelfSignedCert(publicKey, privateKey, cn);
        const newId = crypto.randomUUID();
        const now = new Date();

        // 두 작업을 원자적으로 실행: (1) 기존 활성 키 비활성화, (2) 새 활성 키 INSERT.
        // - d1:            db.batch (D1 은 interactive transaction 미지원).
        // - postgres/mysql: interactive transaction.
        // d1/postgres 는 partial unique index (tenantId WHERE active) 가 동시 rotate 의
        // 두 번째 INSERT 를 UNIQUE 위반으로 막아 단일 active invariant 를 DB 레벨에서 강제한다.
        // MySQL 은 partial unique index 를 지원하지 않으므로 이 트랜잭션이 최선의 보호막이다.
        const buildDeactivate = (h: Pick<DB, "update">) =>
            h
                .update(signingKeys)
                .set({ active: false, rotatedAt: now })
                .where(and(eq(signingKeys.tenantId, tenant.id), eq(signingKeys.active, true), isNull(signingKeys.rotatedAt)));
        const buildInsert = (h: Pick<DB, "insert">) =>
            h.insert(signingKeys).values({
                id: newId,
                tenantId: tenant.id,
                kid,
                alg: "RS256",
                publicJwk: JSON.stringify(publicJwk),
                privateJwkEncrypted,
                certPem,
                active: true,
            });

        try {
            if (DB_DIALECT === "d1" || DB_DIALECT === "sqlite") {
                // d1 / libSQL 은 원자적 batch 지원 (정규 DB 타입이 활성 방언일 때만 노출되므로 캐스팅).
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await (db as any).batch([buildDeactivate(db), buildInsert(db)]);
            } else {
                // postgres / mysql: interactive transaction.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await (db as any).transaction(async (tx: Pick<DB, "update" | "insert">) => {
                    await buildDeactivate(tx);
                    await buildInsert(tx);
                });
            }
        } catch {
            // UNIQUE 위반 (동시 rotate) 또는 기타 DB 에러 → 409
            return fail(409, { error: "다른 rotate 작업이 진행 중이거나 DB 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." });
        }

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

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { eq, and } from "drizzle-orm";
import { requireServiceToken } from "$lib/server/auth/service-token";
import { TOTP_CREDENTIAL_TYPE, BACKUP_CODE_CREDENTIAL_TYPE } from "$lib/server/auth/constants";
import { requireDbContext } from "$lib/server/auth/guards";
import { encryptTotpSecret, generateBackupCodes, hashBackupCode, verifyTotp } from "$lib/server/auth/totp";
import { checkRateLimit } from "$lib/server/ratelimit";
import { credentials, users } from "$lib/server/db/schema";

/**
 * Phase 7.3 — TOTP enrollment confirm.
 * 호출자가 init 에서 받은 secret + 사용자가 입력한 6자리 code 를 보내면
 * 검증 후 영구 저장. 백업 코드 10개 생성 후 plaintext 로 응답 (한 번만 보임).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
    requireServiceToken(request, locals.runtimeConfig);
    const { db } = requireDbContext(locals);

    const config = locals.runtimeConfig;
    if (!config.signingKeySecret) {
        throw error(503, "IDP_SIGNING_KEY_SECRET 미설정");
    }

    const body = (await request.json().catch(() => null)) as { userId?: string; secret?: string; code?: string; label?: string } | null;
    const userId = body?.userId?.trim();
    const secret = body?.secret?.trim();
    const code = body?.code?.replace(/\s/g, "");
    const label = body?.label?.trim() || "TOTP 인증기 (dispatcher)";

    if (!userId || !secret || !code) {
        throw error(400, "userId, secret, code required");
    }

    // ctrls C3: enrollment 코드 브루트포스 방어 (사용자당 5분 창 10회).
    const rl = await checkRateLimit(db, `totp-enroll-confirm:${userId}`, { windowMs: 5 * 60 * 1000, limit: 10 });
    if (!rl.allowed) {
        throw error(429, "TOTP 등록 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.");
    }

    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u) throw error(404, `user ${userId} not found`);

    const [already] = await db
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.userId, userId), eq(credentials.type, TOTP_CREDENTIAL_TYPE)))
        .limit(1);
    if (already) throw error(409, "TOTP already enrolled for this user");

    const verifiedStep = await verifyTotp(code, secret);
    if (verifiedStep === null) {
        throw error(400, "invalid code");
    }

    const encryptedSecret = await encryptTotpSecret(secret, config.signingKeySecret, userId);
    await db.insert(credentials).values({
        id: crypto.randomUUID(),
        userId,
        type: TOTP_CREDENTIAL_TYPE,
        secret: encryptedSecret,
        label,
        // ctrls C3: 등록에 사용한 스텝을 last-used 로 기록 — 동일 코드를 곧바로 /verify 로 재사용 불가.
        counter: verifiedStep,
    });

    const backupCodes = generateBackupCodes();
    for (const c of backupCodes) {
        const hashed = await hashBackupCode(c);
        await db.insert(credentials).values({
            id: crypto.randomUUID(),
            userId,
            type: BACKUP_CODE_CREDENTIAL_TYPE,
            secret: hashed,
            label: "백업 코드 (dispatcher)",
        });
    }

    return json({ ok: true, backupCodes });
};

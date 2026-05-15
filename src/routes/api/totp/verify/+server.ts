import { error, json, type RequestHandler } from "@sveltejs/kit";
import { eq, and } from "drizzle-orm";
import { requireServiceToken } from "$lib/server/auth/service-token";
import { TOTP_CREDENTIAL_TYPE } from "$lib/server/auth/constants";
import { requireDbContext } from "$lib/server/auth/guards";
import { decryptTotpSecret, verifyTotp } from "$lib/server/auth/totp";
import { credentials } from "$lib/server/db/schema";

/**
 * Phase 7.3 — TOTP step-up 검증.
 * dispatcher 가 사용자 입력 6자리 code 를 보내면 idp 가 DB 의 암호화된 secret 으로 검증.
 * 검증 통과 시 credential 의 lastUsedAt 갱신.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
    requireServiceToken(request, locals.runtimeConfig);
    const { db } = requireDbContext(locals);

    const config = locals.runtimeConfig;
    if (!config.signingKeySecret) {
        throw error(503, "IDP_SIGNING_KEY_SECRET 미설정");
    }

    const body = (await request.json().catch(() => null)) as { userId?: string; code?: string } | null;
    const userId = body?.userId?.trim();
    const code = body?.code?.replace(/\s/g, "");
    if (!userId || !code) throw error(400, "userId, code required");

    const [cred] = await db
        .select({ id: credentials.id, secret: credentials.secret })
        .from(credentials)
        .where(and(eq(credentials.userId, userId), eq(credentials.type, TOTP_CREDENTIAL_TYPE)))
        .limit(1);
    if (!cred || !cred.secret) throw error(404, "TOTP not enrolled");

    const plain = await decryptTotpSecret(cred.secret, config.signingKeySecret, userId);
    const step = await verifyTotp(code, plain);
    if (step === null) {
        return json({ ok: false }, { status: 401 });
    }

    const now = new Date();
    await db.update(credentials).set({ lastUsedAt: now, usedAt: now }).where(eq(credentials.id, cred.id));

    return json({ ok: true, verifiedAt: now.toISOString() });
};

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { eq, and } from "drizzle-orm";
import { requireServiceToken } from "$lib/server/auth/service-token";
import { TOTP_CREDENTIAL_TYPE } from "$lib/server/auth/constants";
import { requireDbContext } from "$lib/server/auth/guards";
import { resolveIssuerUrl } from "$lib/server/auth/runtime";
import { buildOtpAuthUri, generateTotpSecret } from "$lib/server/auth/totp";
import { credentials, users } from "$lib/server/db/schema";

/**
 * Phase 7.3 — TOTP enrollment init.
 * 호출자 (stardust dispatcher) 가 userId 를 알려주면 새 base32 secret + otpauth URI 반환.
 *
 * Stateless: idp 가 DB 에 저장하지 않음. 호출자가 secret 을 보관했다가 confirm 에서 다시 보냄.
 * (확정 전에 자리잡지 않으면 사용자가 QR 스캔 도중 dispatcher 가 재시작돼도 그대로 다시 init 가능.)
 *
 * 이미 등록된 사용자는 409 (운영자가 의도적으로 reset 하려면 별도 admin API).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
    await requireServiceToken(request, locals.runtimeConfig);
    const { db } = requireDbContext(locals);

    const body = (await request.json().catch(() => null)) as { userId?: string } | null;
    const userId = body?.userId?.trim();
    if (!userId) throw error(400, "userId required");

    const [u] = await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u) throw error(404, `user ${userId} not found`);

    const [already] = await db
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.userId, userId), eq(credentials.type, TOTP_CREDENTIAL_TYPE)))
        .limit(1);
    if (already) throw error(409, "TOTP already enrolled for this user");

    const secret = generateTotpSecret();
    const issuer = resolveIssuerUrl(locals.runtimeConfig, new URL(request.url).origin);
    const issuerHost = new URL(issuer).host;
    const username = u.username ?? u.id;
    const otpAuthUri = buildOtpAuthUri(secret, username, issuerHost);

    return json({ secret, otpAuthUri, userId: u.id, username });
};

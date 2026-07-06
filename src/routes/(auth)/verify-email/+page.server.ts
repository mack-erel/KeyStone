import { fail } from "@sveltejs/kit";
import { and, eq, isNull } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { users, emailVerificationTokens } from "$lib/server/db/schema";
import { hashToken } from "$lib/server/email";
import { runAtomic } from "$lib/server/db/atomic";
import { checkRateLimit } from "$lib/server/ratelimit";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit";
import { translate } from "$lib/i18n/server";

// 토큰 상태를 tenant 범위에서 조회한다(read-only). 유효하면 record 반환, 아니면 null.
async function lookupToken(db: App.Locals["db"], tenantId: string, token: string) {
    if (!db) return null;
    const tokenHash = await hashToken(token);
    const now = new Date();
    const [record] = await db
        .select({ tokenId: emailVerificationTokens.id, userId: users.id, expiresAt: emailVerificationTokens.expiresAt, emailVerifiedAt: users.emailVerifiedAt })
        .from(emailVerificationTokens)
        .innerJoin(users, eq(emailVerificationTokens.userId, users.id))
        .where(and(eq(emailVerificationTokens.tokenHash, tokenHash), isNull(emailVerificationTokens.usedAt), eq(users.tenantId, tenantId)))
        .limit(1);
    if (!record || record.expiresAt < now) return null;
    return record;
}

export const load: PageServerLoad = async ({ locals, url }) => {
    const token = url.searchParams.get("token");
    if (!token || !locals.db || !locals.tenant) {
        return { valid: false, token: null as string | null, alreadyVerified: false };
    }
    const record = await lookupToken(locals.db, locals.tenant.id, token);
    if (!record) return { valid: false, token: null as string | null, alreadyVerified: false };
    // 이미 인증된 계정의 유효 토큰이면 성공 화면으로 바로 안내(멱등).
    return { valid: true, token: token as string | null, alreadyVerified: !!record.emailVerifiedAt };
};

export const actions: Actions = {
    default: async (event) => {
        const { db, tenant, rateLimitStore } = requireDbContext(event.locals);
        const locale = event.locals.locale;

        const formData = await event.request.formData();
        const token = String(formData.get("token") ?? "");

        // 토큰 제출 브루트포스 방어 — 형제 인증 라우트와 동일하게 IP 당 제한.
        const meta = getRequestMetadata(event);
        const rl = await checkRateLimit(rateLimitStore, `verify-email:${meta.ipKey}`, { windowMs: 15 * 60 * 1000, limit: 10 });
        if (!rl.allowed) {
            return fail(429, { error: translate(locale, "errors.rate_limit", { minutes: Math.ceil(rl.retryAfterMs / 60000) }) });
        }

        if (!token) return fail(400, { error: translate(locale, "verify_email.invalid_link") });

        const record = await lookupToken(db, tenant.id, token);
        if (!record) return fail(400, { error: translate(locale, "verify_email.invalid_link") });

        const now = new Date();
        // 1회용 소진 + emailVerifiedAt 세팅을 원자적으로. 같은 user 의 미사용 토큰을 모두 소진해 재사용 차단.
        await runAtomic(db, [
            (h) =>
                h
                    .update(emailVerificationTokens)
                    .set({ usedAt: now })
                    .where(and(eq(emailVerificationTokens.userId, record.userId), isNull(emailVerificationTokens.usedAt))),
            (h) => h.update(users).set({ emailVerifiedAt: now, updatedAt: now }).where(eq(users.id, record.userId)),
        ]);

        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: record.userId,
            actorId: record.userId,
            kind: "email_verified",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
        });

        return { verified: true };
    },
};

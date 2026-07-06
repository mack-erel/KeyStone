import { fail } from "@sveltejs/kit";
import { and, eq, isNull } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { users, inviteTokens, credentials } from "$lib/server/db/schema";
import { hashToken } from "$lib/server/email";
import { hashPassword } from "$lib/server/auth/password";
import { PASSWORD_CREDENTIAL_TYPE } from "$lib/server/auth/constants";
import { runAtomic } from "$lib/server/db/atomic";
import { checkRateLimit } from "$lib/server/ratelimit";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit";
import { translate } from "$lib/i18n/server";

// 초대 토큰 상태를 tenant 범위에서 조회한다(read-only, 비소진). 유효하면 record, 아니면 null.
async function lookupToken(db: App.Locals["db"], tenantId: string, token: string) {
    if (!db) return null;
    const tokenHash = await hashToken(token);
    const now = new Date();
    const [record] = await db
        .select({ tokenId: inviteTokens.id, userId: users.id, expiresAt: inviteTokens.expiresAt })
        .from(inviteTokens)
        .innerJoin(users, eq(inviteTokens.userId, users.id))
        .where(and(eq(inviteTokens.tokenHash, tokenHash), isNull(inviteTokens.usedAt), eq(users.tenantId, tenantId)))
        .limit(1);
    if (!record || record.expiresAt < now) return null;
    return record;
}

export const load: PageServerLoad = async ({ locals, url }) => {
    const token = url.searchParams.get("token");
    if (!token || !locals.db || !locals.tenant) {
        return { valid: false, token: null as string | null };
    }
    const record = await lookupToken(locals.db, locals.tenant.id, token);
    if (!record) return { valid: false, token: null as string | null };
    return { valid: true, token: token as string | null };
};

export const actions: Actions = {
    default: async (event) => {
        const { db, tenant } = requireDbContext(event.locals);
        const locale = event.locals.locale;

        const formData = await event.request.formData();
        const token = String(formData.get("token") ?? "");
        const password = String(formData.get("password") ?? "");
        const confirmPassword = String(formData.get("confirmPassword") ?? "");

        // 토큰 제출 브루트포스 방어 — 형제 인증 라우트와 동일하게 IP 당 제한.
        const meta = getRequestMetadata(event);
        const rl = await checkRateLimit(db, `accept-invite:${meta.ipKey}`, { windowMs: 15 * 60 * 1000, limit: 10 });
        if (!rl.allowed) {
            return fail(429, { error: translate(locale, "errors.rate_limit", { minutes: Math.ceil(rl.retryAfterMs / 60000) }) });
        }

        if (!token) return fail(400, { error: translate(locale, "accept_invite.invalid_link") });
        // 비밀번호 정책 재사용 — reset_password 와 동일(8자 이상, 확인 일치).
        if (password.length < 8) return fail(400, { error: translate(locale, "accept_invite.err_password_short") });
        if (password !== confirmPassword) return fail(400, { error: translate(locale, "accept_invite.err_password_mismatch") });

        const record = await lookupToken(db, tenant.id, token);
        if (!record) return fail(400, { error: translate(locale, "accept_invite.invalid_link") });

        const now = new Date();
        const hashedPw = await hashPassword(password);

        // 초대 클릭 = 이메일 소유 증명이므로 emailVerifiedAt 을 함께 세팅(별도 이메일 인증 스킵).
        // 최초 비밀번호 설정(credentials insert) + emailVerifiedAt 세팅 + 토큰 소진을 원자적으로.
        // 같은 user 의 미사용 초대 토큰을 모두 소진해 재사용을 차단한다.
        await runAtomic(db, [
            (h) =>
                h.insert(credentials).values({
                    id: crypto.randomUUID(),
                    userId: record.userId,
                    type: PASSWORD_CREDENTIAL_TYPE,
                    secret: hashedPw,
                    label: "비밀번호",
                }),
            (h) => h.update(users).set({ emailVerifiedAt: now, updatedAt: now }).where(eq(users.id, record.userId)),
            (h) =>
                h
                    .update(inviteTokens)
                    .set({ usedAt: now })
                    .where(and(eq(inviteTokens.userId, record.userId), isNull(inviteTokens.usedAt))),
        ]);

        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: record.userId,
            actorId: record.userId,
            kind: "invite_accepted",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
        });

        return { accepted: true };
    },
};

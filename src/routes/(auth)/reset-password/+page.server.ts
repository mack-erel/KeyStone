import { fail, redirect } from "@sveltejs/kit";
import { eq, and, isNull } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { users, passwordResetTokens } from "$lib/server/db/schema";
import { hashPassword } from "$lib/server/auth/password";
import { hashToken } from "$lib/server/email";
import { revokeAllUserSessions } from "$lib/server/auth/session";
import { revokeAllUserRefreshTokens } from "$lib/server/oidc/refresh";
import { resolve } from "$app/paths";
import { sanitizeRedirectTarget } from "$lib/server/auth/redirect";
import { resolveSkinHtml, replacePlaceholders, escapeHtml } from "$lib/server/skin/resolver";
import { checkRateLimit } from "$lib/server/ratelimit";
import { getRequestMetadata } from "$lib/server/audit";
import { translate } from "$lib/i18n/server";
import { dispatchSecurityAlert } from "$lib/server/security-notify";

async function resolveSkin(skinHint: string | null, locals: App.Locals, platform: App.Platform | undefined, token: string | null, redirectTo: string | null, flashMsg = ""): Promise<string | null> {
    if (!skinHint || !locals.db || !locals.tenant) return null;
    const colonIdx = skinHint.indexOf(":");
    if (colonIdx <= 0) return null;
    const clientType = skinHint.slice(0, colonIdx) as "oidc" | "saml";
    const clientRefId = skinHint.slice(colonIdx + 1);
    if (clientType !== "oidc" && clientType !== "saml") return null;
    const raw = await resolveSkinHtml(locals.db, platform, locals.tenant.id, clientType, clientRefId, "reset_password");
    if (!raw) return null;
    return replacePlaceholders(raw, {
        IDP_FORM_ACTION: "",
        IDP_REDIRECT_TO: escapeHtml(redirectTo ?? ""),
        IDP_SKIN_HINT: escapeHtml(skinHint),
        IDP_TOKEN: escapeHtml(token ?? ""),
        IDP_FLASH_MSG: escapeHtml(flashMsg),
    });
}

export const load: PageServerLoad = async ({ locals, url, platform }) => {
    const redirectTo = sanitizeRedirectTarget(url.searchParams.get("redirectTo"));
    const skinHint = url.searchParams.get("skinHint") ?? null;

    const token = url.searchParams.get("token");
    if (!token) {
        const skinHtml = await resolveSkin(skinHint, locals, platform, null, redirectTo);
        return { valid: false, token: null, redirectTo, skinHint, skinHtml };
    }

    if (!locals.db) {
        const skinHtml = await resolveSkin(skinHint, locals, platform, token, redirectTo);
        return { valid: false, token: null, redirectTo, skinHint, skinHtml };
    }

    const tokenHash = await hashToken(token);
    const now = new Date();

    const [record] = await locals.db
        .select({ id: passwordResetTokens.id, expiresAt: passwordResetTokens.expiresAt })
        .from(passwordResetTokens)
        .where(and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(passwordResetTokens.usedAt)))
        .limit(1);

    const valid = !!(record && record.expiresAt >= now);
    const skinHtml = await resolveSkin(skinHint, locals, platform, valid ? token : null, redirectTo);

    if (!valid) return { valid: false, token, redirectTo, skinHint, skinHtml };

    return { valid: true, token, redirectTo, skinHint, skinHtml };
};

export const actions: Actions = {
    default: async (event) => {
        const { db, rateLimitStore } = requireDbContext(event.locals);

        const formData = await event.request.formData();
        const token = String(formData.get("token") ?? "");
        const password = String(formData.get("password") ?? "");
        const confirmPassword = String(formData.get("confirmPassword") ?? "");
        const redirectTo = sanitizeRedirectTarget(String(formData.get("redirectTo") ?? ""));
        const skinHint = String(formData.get("skinHint") ?? "");

        const locale = event.locals.locale;
        const failWithSkin = async (msg: string) => fail(400, { error: msg, skinHtml: await resolveSkin(skinHint || null, event.locals, event.platform, token || null, redirectTo, msg) });

        // ctrls C8: 토큰 제출 브루트포스/자동화 방어. 토큰이 256bit CSPRNG 라 추측 실익은
        // 낮지만, 형제 인증 라우트와 동일하게 IP 당 시도를 제한해 정합성·DB 부하를 막는다.
        const meta = getRequestMetadata(event);
        const rl = await checkRateLimit(rateLimitStore, `reset-password:${meta.ipKey}`, { windowMs: 15 * 60 * 1000, limit: 10 });
        if (!rl.allowed) {
            return failWithSkin(translate(locale, "errors.rate_limit", { minutes: Math.ceil(rl.retryAfterMs / 60000) }));
        }

        if (!token) return failWithSkin(translate(locale, "reset_password.err_invalid_request"));
        if (password.length < 8) return failWithSkin(translate(locale, "reset_password.err_password_short"));
        if (password !== confirmPassword) return failWithSkin(translate(locale, "reset_password.err_password_mismatch"));

        const tokenHash = await hashToken(token);
        const now = new Date();

        const [record] = await db
            .select({ id: passwordResetTokens.id, userId: passwordResetTokens.userId, expiresAt: passwordResetTokens.expiresAt, email: users.email, locale: users.locale })
            .from(passwordResetTokens)
            .innerJoin(users, eq(passwordResetTokens.userId, users.id))
            .where(and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(passwordResetTokens.usedAt)))
            .limit(1);

        if (!record || record.expiresAt < now) return failWithSkin(translate(locale, "reset_password.err_expired_link"));

        const hashedPw = await hashPassword(password);

        await db.update(users).set({ updatedAt: now }).where(eq(users.id, record.userId));

        // 기존 password credential 업데이트 또는 삽입
        const { credentials } = await import("$lib/server/db/schema");
        const [existing] = await db
            .select({ id: credentials.id })
            .from(credentials)
            .where(and(eq(credentials.userId, record.userId), eq(credentials.type, "password")))
            .limit(1);

        if (existing) {
            await db.update(credentials).set({ secret: hashedPw }).where(eq(credentials.id, existing.id));
        } else {
            await db.insert(credentials).values({ userId: record.userId, type: "password", secret: hashedPw, label: "비밀번호", createdAt: now });
        }

        await db.update(passwordResetTokens).set({ usedAt: now }).where(eq(passwordResetTokens.id, record.id));

        // 같은 사용자의 다른 미사용 reset 토큰들도 모두 소진 처리해 재사용을 차단한다.
        await db
            .update(passwordResetTokens)
            .set({ usedAt: now })
            .where(and(eq(passwordResetTokens.userId, record.userId), isNull(passwordResetTokens.usedAt)));

        // 비밀번호가 바뀌었으므로 기존 세션과 OIDC refresh token 을 모두 무효화한다.
        await revokeAllUserSessions(db, record.userId, now);
        await revokeAllUserRefreshTokens(db, record.userId);

        // 보안 알림(best-effort, 완전 격리) — 비밀번호가 변경됨.
        dispatchSecurityAlert({ to: record.email, locale: record.locale, kind: "password_changed", when: now, platform: event.platform });

        const extra = new URLSearchParams();
        if (redirectTo) extra.set("redirectTo", redirectTo);
        if (skinHint) extra.set("skinHint", skinHint);
        const extraStr = extra.toString();
        throw redirect(302, resolve("/login") + "?passwordReset=1" + (extraStr ? `&${extraStr}` : ""));
    },
};

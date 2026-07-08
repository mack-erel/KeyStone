import { fail, redirect } from "@sveltejs/kit";
import { eq, and } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { resolveSkinHtml, replacePlaceholders, escapeHtml } from "$lib/server/skin/resolver";
import { requireDbContext } from "$lib/server/auth/guards";
import { hashPassword, MAX_PASSWORD_LENGTH } from "$lib/server/auth/password";
import { users, credentials, identities } from "$lib/server/db/schema";
import { resolve } from "$app/paths";
import { sanitizeRedirectTarget } from "$lib/server/auth/redirect";
import { checkRateLimit } from "$lib/server/ratelimit";
import { getRequestMetadata } from "$lib/server/audit";
import { translate } from "$lib/i18n/server";
import { issueEmailVerification } from "$lib/server/auth/email-verification";

export const load: PageServerLoad = async ({ locals, url, platform }) => {
    const skinHint = url.searchParams.get("skinHint");
    const redirectTo = sanitizeRedirectTarget(url.searchParams.get("redirectTo"));
    let skinHtml: string | null = null;

    if (skinHint && locals.db && locals.tenant) {
        const colonIdx = skinHint.indexOf(":");
        if (colonIdx > 0) {
            const clientType = skinHint.slice(0, colonIdx) as "oidc" | "saml";
            const clientRefId = skinHint.slice(colonIdx + 1);
            if ((clientType === "oidc" || clientType === "saml") && clientRefId) {
                const raw = await resolveSkinHtml(locals.db, platform, locals.tenant.id, clientType, clientRefId, "signup");
                if (raw) {
                    skinHtml = replacePlaceholders(raw, {
                        IDP_FORM_ACTION: "",
                        IDP_SKIN_HINT: escapeHtml(skinHint),
                        IDP_REDIRECT_TO: escapeHtml(redirectTo ?? ""),
                        IDP_FLASH_MSG: "",
                    });
                }
            }
        }
    }

    return { skinHint, skinHtml, redirectTo };
};

async function resolveSkinForAction(event: Parameters<Actions["default"]>[0], flashMsg: string): Promise<string | null> {
    const skinHint = event.url.searchParams.get("skinHint");
    if (!skinHint || !event.locals.db || !event.locals.tenant) return null;
    const colonIdx = skinHint.indexOf(":");
    if (colonIdx <= 0) return null;
    const clientType = skinHint.slice(0, colonIdx) as "oidc" | "saml";
    const clientRefId = skinHint.slice(colonIdx + 1);
    if ((clientType !== "oidc" && clientType !== "saml") || !clientRefId) return null;
    const raw = await resolveSkinHtml(event.locals.db, event.platform, event.locals.tenant.id, clientType, clientRefId, "signup");
    if (!raw) return null;
    const redirectTo = sanitizeRedirectTarget(event.url.searchParams.get("redirectTo"));
    return replacePlaceholders(raw, {
        IDP_FORM_ACTION: "",
        IDP_SKIN_HINT: escapeHtml(skinHint),
        IDP_REDIRECT_TO: escapeHtml(redirectTo ?? ""),
        IDP_FLASH_MSG: escapeHtml(flashMsg),
    });
}

export const actions: Actions = {
    default: async (event) => {
        const { db, tenant, rateLimitStore } = requireDbContext(event.locals);

        const formData = await event.request.formData();
        const username = String(formData.get("username") ?? "")
            .trim()
            .toLowerCase();
        const email = String(formData.get("email") ?? "")
            .trim()
            .toLowerCase();
        const password = String(formData.get("password") ?? "");
        const confirmPassword = String(formData.get("confirmPassword") ?? "");

        const locale = event.locals.locale;
        const failSkin = async (status: number, msg: string) => fail(status, { error: msg, skinHtml: await resolveSkinForAction(event, msg) });

        // IP 기반 레이트리밋 — 60분/5회.
        const meta = getRequestMetadata(event);
        const rl = await checkRateLimit(rateLimitStore, `signup:${meta.ipKey}`, { windowMs: 60 * 60 * 1000, limit: 5 });
        if (!rl.allowed) {
            return failSkin(429, translate(locale, "signup.err_rate_limit", { minutes: Math.ceil(rl.retryAfterMs / 60000) }));
        }

        if (!username || !email || !password) return failSkin(400, translate(locale, "signup.err_missing_fields"));
        if (!/^[a-z0-9_]{3,32}$/.test(username)) return failSkin(400, translate(locale, "signup.err_invalid_username"));
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return failSkin(400, translate(locale, "signup.err_invalid_email"));
        if (password.length < 8) return failSkin(400, translate(locale, "signup.err_password_short"));
        if (password.length > MAX_PASSWORD_LENGTH) return failSkin(400, translate(locale, "errors.password_too_long", { max: MAX_PASSWORD_LENGTH }));
        if (password !== confirmPassword) return failSkin(400, translate(locale, "signup.err_password_mismatch"));

        const [existingByUsername] = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.tenantId, tenant.id), eq(users.username, username)))
            .limit(1);
        if (existingByUsername) return failSkin(409, translate(locale, "signup.err_username_taken"));

        const [existingByEmail] = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.tenantId, tenant.id), eq(users.email, email)))
            .limit(1);
        if (existingByEmail) return failSkin(409, translate(locale, "signup.err_email_taken"));

        const hashedPw = await hashPassword(password);
        const userId = crypto.randomUUID();
        const now = new Date();

        await db.insert(users).values({ id: userId, tenantId: tenant.id, username, email, displayName: username, role: "user", status: "active" });
        await db.insert(credentials).values({ userId, type: "password", secret: hashedPw, label: "비밀번호", createdAt: now });
        await db.insert(identities).values({ tenantId: tenant.id, userId, provider: "local", subject: email, email, linkedAt: now });

        // 이메일 인증 메일 발송 — 실패해도 가입은 성공 처리(격리).
        await issueEmailVerification(db, userId, email, locale, event.platform);

        const redirectTo = sanitizeRedirectTarget(event.url.searchParams.get("redirectTo"));
        const skinHint = event.url.searchParams.get("skinHint") ?? "";
        const extra = new URLSearchParams();
        if (redirectTo) extra.set("redirectTo", redirectTo);
        if (skinHint) extra.set("skinHint", skinHint);
        const extraStr = extra.toString();
        throw redirect(302, resolve("/login") + "?registered=1" + (extraStr ? `&${extraStr}` : ""));
    },
};

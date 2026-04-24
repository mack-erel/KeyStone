import { fail, redirect } from "@sveltejs/kit";
import { eq, and, isNull } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { users, passwordResetTokens } from "$lib/server/db/schema";
import { hashPassword } from "$lib/server/auth/password";
import { hashToken } from "$lib/server/email";
import { resolve } from "$app/paths";
import { sanitizeRedirectTarget } from "$lib/server/auth/redirect";
import { resolveSkinHtml, replacePlaceholders, escapeHtml } from "$lib/server/skin/resolver";

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
        const { db } = requireDbContext(event.locals);

        const formData = await event.request.formData();
        const token = String(formData.get("token") ?? "");
        const password = String(formData.get("password") ?? "");
        const confirmPassword = String(formData.get("confirmPassword") ?? "");
        const redirectTo = sanitizeRedirectTarget(String(formData.get("redirectTo") ?? ""));
        const skinHint = String(formData.get("skinHint") ?? "");

        const failWithSkin = async (msg: string) => fail(400, { error: msg, skinHtml: await resolveSkin(skinHint || null, event.locals, event.platform, token || null, redirectTo, msg) });

        if (!token) return failWithSkin("유효하지 않은 요청입니다.");
        if (password.length < 8) return failWithSkin("비밀번호는 8자 이상이어야 합니다.");
        if (password !== confirmPassword) return failWithSkin("비밀번호가 일치하지 않습니다.");

        const tokenHash = await hashToken(token);
        const now = new Date();

        const [record] = await db
            .select({ id: passwordResetTokens.id, userId: passwordResetTokens.userId, expiresAt: passwordResetTokens.expiresAt })
            .from(passwordResetTokens)
            .where(and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(passwordResetTokens.usedAt)))
            .limit(1);

        if (!record || record.expiresAt < now) return failWithSkin("링크가 만료되었거나 이미 사용된 링크입니다.");

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

        const extra = new URLSearchParams();
        if (redirectTo) extra.set("redirectTo", redirectTo);
        if (skinHint) extra.set("skinHint", skinHint);
        const extraStr = extra.toString();
        throw redirect(302, resolve("/login") + "?passwordReset=1" + (extraStr ? `&${extraStr}` : ""));
    },
};

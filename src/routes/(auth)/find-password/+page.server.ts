import { fail } from "@sveltejs/kit";
import { eq, and } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { resolveSkinHtml, replacePlaceholders, escapeHtml } from "$lib/server/skin/resolver";
import { requireDbContext } from "$lib/server/auth/guards";
import { users, passwordResetTokens } from "$lib/server/db/schema";
import { sendPasswordResetEmail, generateToken } from "$lib/server/email";
import { env } from "$env/dynamic/private";

const RESET_EXPIRY_MS = 60 * 60 * 1000;

export const load: PageServerLoad = async ({ locals, url, platform }) => {
    const skinHint = url.searchParams.get("skinHint");
    let skinHtml: string | null = null;

    if (skinHint && locals.db && locals.tenant) {
        const colonIdx = skinHint.indexOf(":");
        if (colonIdx > 0) {
            const clientType = skinHint.slice(0, colonIdx) as "oidc" | "saml";
            const clientRefId = skinHint.slice(colonIdx + 1);
            if ((clientType === "oidc" || clientType === "saml") && clientRefId) {
                const raw = await resolveSkinHtml(locals.db, platform, locals.tenant.id, clientType, clientRefId, "find_password");
                if (raw) {
                    skinHtml = replacePlaceholders(raw, {
                        IDP_FORM_ACTION: "",
                        IDP_SKIN_HINT: escapeHtml(skinHint),
                    });
                }
            }
        }
    }

    const redirectTo = url.searchParams.get("redirectTo") ?? null;
    return { skinHint, skinHtml, redirectTo };
};

async function resolveSkinForAction(event: Parameters<Actions["default"]>[0], sent: boolean): Promise<string | null> {
    const skinHint = event.url.searchParams.get("skinHint");
    if (!skinHint || !event.locals.db || !event.locals.tenant) return null;
    const colonIdx = skinHint.indexOf(":");
    if (colonIdx <= 0) return null;
    const clientType = skinHint.slice(0, colonIdx) as "oidc" | "saml";
    const clientRefId = skinHint.slice(colonIdx + 1);
    if ((clientType !== "oidc" && clientType !== "saml") || !clientRefId) return null;
    const raw = await resolveSkinHtml(event.locals.db, event.platform, event.locals.tenant.id, clientType, clientRefId, "find_password");
    if (!raw) return null;
    return replacePlaceholders(raw, {
        IDP_FORM_ACTION: "",
        IDP_SKIN_HINT: escapeHtml(skinHint),
        IDP_FIND_PASSWORD_SENT: sent ? "1" : "",
    });
}

export const actions: Actions = {
    default: async (event) => {
        const { db, tenant } = requireDbContext(event.locals);

        const formData = await event.request.formData();
        const email = String(formData.get("email") ?? "")
            .trim()
            .toLowerCase();
        const username = String(formData.get("username") ?? "")
            .trim()
            .toLowerCase();

        if (!email || !username) return fail(400, { error: "이메일과 아이디를 모두 입력해 주세요." });

        const [user] = await db
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(and(eq(users.tenantId, tenant.id), eq(users.email, email), eq(users.username, username)))
            .limit(1);

        if (user) {
            try {
                const { token, tokenHash } = await generateToken();
                const expiresAt = new Date(Date.now() + RESET_EXPIRY_MS);
                await db.insert(passwordResetTokens).values({ userId: user.id, tokenHash, expiresAt });
                const issuer = (env.IDP_ISSUER_URL ?? event.url.origin).replace(/\.+$/, "").replace(/\/+$/, "");
                const resetParams = new URLSearchParams({ token });
                const redirectTo = event.url.searchParams.get("redirectTo");
                const skinHint = event.url.searchParams.get("skinHint");
                if (redirectTo) resetParams.set("redirectTo", redirectTo);
                if (skinHint) resetParams.set("skinHint", skinHint);
                const resetUrl = `${issuer}/reset-password?${resetParams.toString()}`;
                await sendPasswordResetEmail(user.email, resetUrl);
            } catch {
                // 조용히 무시
            }
        }

        return { sent: true, skinHtml: await resolveSkinForAction(event, true) };
    },
};

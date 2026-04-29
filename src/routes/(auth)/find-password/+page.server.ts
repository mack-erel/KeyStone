import { fail } from "@sveltejs/kit";
import { eq, and, isNull } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { resolveSkinHtml, replacePlaceholders, escapeHtml } from "$lib/server/skin/resolver";
import { requireDbContext } from "$lib/server/auth/guards";
import { users, passwordResetTokens } from "$lib/server/db/schema";
import { sendPasswordResetEmail, generateToken } from "$lib/server/email";
import { checkRateLimit } from "$lib/server/ratelimit";
import { getRequestMetadata } from "$lib/server/audit";
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
                        IDP_REDIRECT_TO: "",
                        IDP_FIND_PASSWORD_SENT: "",
                        IDP_SUBMITTED_EMAIL: "",
                        IDP_FLASH_MSG: "",
                    });
                }
            }
        }
    }

    const redirectTo = url.searchParams.get("redirectTo") ?? null;
    return { skinHint, skinHtml, redirectTo };
};

async function resolveSkinForAction(event: Parameters<Actions["default"]>[0], sent: boolean, submittedEmail?: string, flashMsg = ""): Promise<string | null> {
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
        IDP_REDIRECT_TO: "",
        IDP_FIND_PASSWORD_SENT: sent ? "1" : "",
        IDP_SUBMITTED_EMAIL: submittedEmail ? escapeHtml(submittedEmail) : "",
        IDP_FLASH_MSG: escapeHtml(flashMsg),
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

        if (!email || !username) {
            const msg = "이메일과 아이디를 모두 입력해 주세요.";
            return fail(400, { error: msg, skinHtml: await resolveSkinForAction(event, false, undefined, msg) });
        }

        // IP 기반 레이트리밋 — 60분/5회.
        const meta = getRequestMetadata(event);
        const rl = await checkRateLimit(db, `find-password:${meta.ip ?? "unknown"}`, { windowMs: 60 * 60 * 1000, limit: 5 });
        if (!rl.allowed) {
            const msg = `요청이 너무 많습니다. ${Math.ceil(rl.retryAfterMs / 60000)}분 후 다시 시도해 주세요.`;
            return fail(429, { error: msg, skinHtml: await resolveSkinForAction(event, false, undefined, msg) });
        }

        const [user] = await db
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(and(eq(users.tenantId, tenant.id), eq(users.email, email), eq(users.username, username)))
            .limit(1);

        if (user) {
            try {
                // 같은 user 의 미사용 토큰을 모두 사용 처리하여 새 토큰만 유효하게.
                await db
                    .update(passwordResetTokens)
                    .set({ usedAt: new Date() })
                    .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));

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

        // 메일 발송 분기와 미발송 분기 모두 timing 균등화 — 200~300ms.
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 100));

        return { sent: true, skinHtml: await resolveSkinForAction(event, true, email) };
    },
};

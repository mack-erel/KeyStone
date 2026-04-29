import { fail } from "@sveltejs/kit";
import { eq, and } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { resolveSkinHtml, replacePlaceholders, escapeHtml } from "$lib/server/skin/resolver";
import { requireDbContext } from "$lib/server/auth/guards";
import { users } from "$lib/server/db/schema";
import { sendFindIdEmail } from "$lib/server/email";
import { checkRateLimit } from "$lib/server/ratelimit";
import { getRequestMetadata } from "$lib/server/audit";

export const load: PageServerLoad = async ({ locals, url, platform }) => {
    const skinHint = url.searchParams.get("skinHint");
    let skinHtml: string | null = null;

    if (skinHint && locals.db && locals.tenant) {
        const colonIdx = skinHint.indexOf(":");
        if (colonIdx > 0) {
            const clientType = skinHint.slice(0, colonIdx) as "oidc" | "saml";
            const clientRefId = skinHint.slice(colonIdx + 1);
            if ((clientType === "oidc" || clientType === "saml") && clientRefId) {
                const raw = await resolveSkinHtml(locals.db, platform, locals.tenant.id, clientType, clientRefId, "find_id");
                if (raw) {
                    skinHtml = replacePlaceholders(raw, {
                        IDP_FORM_ACTION: "",
                        IDP_SKIN_HINT: escapeHtml(skinHint),
                        IDP_REDIRECT_TO: "",
                        IDP_FIND_ID_SENT: "",
                        IDP_MASKED_USERNAME: "",
                        IDP_FLASH_MSG: "",
                    });
                }
            }
        }
    }

    const redirectTo = url.searchParams.get("redirectTo") ?? null;
    return { skinHint, skinHtml, redirectTo };
};

async function resolveSkinForAction(event: Parameters<Actions["default"]>[0], sent: boolean, maskedUsername: string | null, flashMsg = ""): Promise<string | null> {
    const skinHint = event.url.searchParams.get("skinHint");
    if (!skinHint || !event.locals.db || !event.locals.tenant) return null;
    const colonIdx = skinHint.indexOf(":");
    if (colonIdx <= 0) return null;
    const clientType = skinHint.slice(0, colonIdx) as "oidc" | "saml";
    const clientRefId = skinHint.slice(colonIdx + 1);
    if ((clientType !== "oidc" && clientType !== "saml") || !clientRefId) return null;
    const raw = await resolveSkinHtml(event.locals.db, event.platform, event.locals.tenant.id, clientType, clientRefId, "find_id");
    if (!raw) return null;
    return replacePlaceholders(raw, {
        IDP_FORM_ACTION: "",
        IDP_SKIN_HINT: escapeHtml(skinHint),
        IDP_REDIRECT_TO: "",
        IDP_FIND_ID_SENT: sent ? "1" : "",
        IDP_MASKED_USERNAME: maskedUsername ? escapeHtml(maskedUsername) : "",
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

        if (!email) {
            const msg = "이메일을 입력해 주세요.";
            return fail(400, { error: msg, skinHtml: await resolveSkinForAction(event, false, null, msg) });
        }

        // IP 기반 레이트리밋 — 60분/5회.
        const meta = getRequestMetadata(event);
        const rl = await checkRateLimit(db, `find-id:${meta.ip ?? "unknown"}`, { windowMs: 60 * 60 * 1000, limit: 5 });
        if (!rl.allowed) {
            const msg = `요청이 너무 많습니다. ${Math.ceil(rl.retryAfterMs / 60000)}분 후 다시 시도해 주세요.`;
            return fail(429, { error: msg, skinHtml: await resolveSkinForAction(event, false, null, msg) });
        }

        const [user] = await db
            .select({ username: users.username })
            .from(users)
            .where(and(eq(users.tenantId, tenant.id), eq(users.email, email)))
            .limit(1);

        if (user?.username) {
            try {
                await sendFindIdEmail(email, user.username);
            } catch {
                // 메일 발송 실패는 조용히 무시
            }
        }

        // 계정 존재 여부가 응답 페이로드로 새지 않도록 항상 동일 응답을 반환한다.
        // 사용자에게는 "메일을 보냈으니 확인해 주세요" 메시지만 노출.
        return { sent: true, maskedUsername: null, skinHtml: await resolveSkinForAction(event, true, null) };
    },
};

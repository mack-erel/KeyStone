import { fail } from "@sveltejs/kit";
import { eq, and } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { resolveSkinHtml, replacePlaceholders, escapeHtml } from "$lib/server/skin/resolver";
import { requireDbContext } from "$lib/server/auth/guards";
import { users } from "$lib/server/db/schema";
import { sendFindIdEmail, maskUsername } from "$lib/server/email";

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
                    });
                }
            }
        }
    }

    return { skinHint, skinHtml };
};

export const actions: Actions = {
    default: async (event) => {
        const { db, tenant } = requireDbContext(event.locals);

        const formData = await event.request.formData();
        const email = String(formData.get("email") ?? "")
            .trim()
            .toLowerCase();

        if (!email) return fail(400, { error: "이메일을 입력해 주세요." });

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
            return { sent: true, maskedUsername: maskUsername(user.username) };
        }

        // 계정 존재 여부 노출 방지
        return { sent: true, maskedUsername: null };
    },
};

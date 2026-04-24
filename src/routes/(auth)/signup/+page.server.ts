import { fail, redirect } from "@sveltejs/kit";
import { eq, and } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { resolveSkinHtml, replacePlaceholders, escapeHtml } from "$lib/server/skin/resolver";
import { requireDbContext } from "$lib/server/auth/guards";
import { hashPassword } from "$lib/server/auth/password";
import { users, credentials, identities } from "$lib/server/db/schema";
import { resolve } from "$app/paths";
import { sanitizeRedirectTarget } from "$lib/server/auth/redirect";

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
        const { db, tenant } = requireDbContext(event.locals);

        const formData = await event.request.formData();
        const username = String(formData.get("username") ?? "")
            .trim()
            .toLowerCase();
        const email = String(formData.get("email") ?? "")
            .trim()
            .toLowerCase();
        const password = String(formData.get("password") ?? "");
        const confirmPassword = String(formData.get("confirmPassword") ?? "");

        const failSkin = async (status: number, msg: string) => fail(status, { error: msg, skinHtml: await resolveSkinForAction(event, msg) });

        if (!username || !email || !password) return failSkin(400, "모든 필드를 입력해 주세요.");
        if (!/^[a-z0-9_]{3,32}$/.test(username)) return failSkin(400, "아이디는 영문 소문자, 숫자, _만 사용 가능하며 3~32자여야 합니다.");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return failSkin(400, "올바른 이메일 주소를 입력해 주세요.");
        if (password.length < 8) return failSkin(400, "비밀번호는 8자 이상이어야 합니다.");
        if (password !== confirmPassword) return failSkin(400, "비밀번호가 일치하지 않습니다.");

        const [existingByUsername] = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.tenantId, tenant.id), eq(users.username, username)))
            .limit(1);
        if (existingByUsername) return failSkin(409, "이미 사용 중인 아이디입니다.");

        const [existingByEmail] = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.tenantId, tenant.id), eq(users.email, email)))
            .limit(1);
        if (existingByEmail) return failSkin(409, "이미 사용 중인 이메일입니다.");

        const hashedPw = await hashPassword(password);
        const userId = crypto.randomUUID();
        const now = new Date();

        await db.insert(users).values({ id: userId, tenantId: tenant.id, username, email, displayName: username, role: "user", status: "active" });
        await db.insert(credentials).values({ userId, type: "password", secret: hashedPw, label: "비밀번호", createdAt: now });
        await db.insert(identities).values({ tenantId: tenant.id, userId, provider: "local", subject: email, email, linkedAt: now });

        const redirectTo = sanitizeRedirectTarget(event.url.searchParams.get("redirectTo"));
        const skinHint = event.url.searchParams.get("skinHint") ?? "";
        const extra = new URLSearchParams();
        if (redirectTo) extra.set("redirectTo", redirectTo);
        if (skinHint) extra.set("skinHint", skinHint);
        const extraStr = extra.toString();
        throw redirect(302, resolve("/login") + "?registered=1" + (extraStr ? `&${extraStr}` : ""));
    },
};

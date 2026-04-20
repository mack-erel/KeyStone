import { fail, redirect } from "@sveltejs/kit";
import { eq, and } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { resolveSkinHtml, replacePlaceholders, escapeHtml } from "$lib/server/skin/resolver";
import { requireDbContext } from "$lib/server/auth/guards";
import { hashPassword } from "$lib/server/auth/password";
import { users, credentials, identities } from "$lib/server/db/schema";
import { resolve } from "$app/paths";

export const load: PageServerLoad = async ({ locals, url, platform }) => {
    const skinHint = url.searchParams.get("skinHint");
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
        const username = String(formData.get("username") ?? "")
            .trim()
            .toLowerCase();
        const email = String(formData.get("email") ?? "")
            .trim()
            .toLowerCase();
        const password = String(formData.get("password") ?? "");
        const confirmPassword = String(formData.get("confirmPassword") ?? "");

        if (!username || !email || !password) return fail(400, { error: "모든 필드를 입력해 주세요." });
        if (!/^[a-z0-9_]{3,32}$/.test(username)) return fail(400, { error: "아이디는 영문 소문자, 숫자, _만 사용 가능하며 3~32자여야 합니다." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, { error: "올바른 이메일 주소를 입력해 주세요." });
        if (password.length < 8) return fail(400, { error: "비밀번호는 8자 이상이어야 합니다." });
        if (password !== confirmPassword) return fail(400, { error: "비밀번호가 일치하지 않습니다." });

        const [existingByUsername] = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.tenantId, tenant.id), eq(users.username, username)))
            .limit(1);
        if (existingByUsername) return fail(409, { error: "이미 사용 중인 아이디입니다." });

        const [existingByEmail] = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.tenantId, tenant.id), eq(users.email, email)))
            .limit(1);
        if (existingByEmail) return fail(409, { error: "이미 사용 중인 이메일입니다." });

        const hashedPw = await hashPassword(password);
        const userId = crypto.randomUUID();
        const now = new Date();

        await db.insert(users).values({ id: userId, tenantId: tenant.id, username, email, displayName: username, role: "user", status: "active" });
        await db.insert(credentials).values({ userId, type: "password", secret: hashedPw, label: "비밀번호", createdAt: now });
        await db.insert(identities).values({ tenantId: tenant.id, userId, provider: "local", subject: email, email, linkedAt: now });

        throw redirect(302, resolve("/login") + "?registered=1");
    },
};

import { fail, redirect } from "@sveltejs/kit";
import { eq, and, isNull } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { users, passwordResetTokens } from "$lib/server/db/schema";
import { hashPassword } from "$lib/server/auth/password";
import { hashToken } from "$lib/server/email";
import { resolve } from "$app/paths";

export const load: PageServerLoad = async ({ locals, url }) => {
    const token = url.searchParams.get("token");
    if (!token) return { valid: false, token: null };

    if (!locals.db) return { valid: false, token: null };

    const tokenHash = await hashToken(token);
    const now = new Date();

    const [record] = await locals.db
        .select({ id: passwordResetTokens.id, expiresAt: passwordResetTokens.expiresAt })
        .from(passwordResetTokens)
        .where(and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(passwordResetTokens.usedAt)))
        .limit(1);

    if (!record || record.expiresAt < now) return { valid: false, token };

    return { valid: true, token };
};

export const actions: Actions = {
    default: async (event) => {
        const { db } = requireDbContext(event.locals);

        const formData = await event.request.formData();
        const token = String(formData.get("token") ?? "");
        const password = String(formData.get("password") ?? "");
        const confirmPassword = String(formData.get("confirmPassword") ?? "");

        if (!token) return fail(400, { error: "유효하지 않은 요청입니다." });
        if (password.length < 8) return fail(400, { error: "비밀번호는 8자 이상이어야 합니다." });
        if (password !== confirmPassword) return fail(400, { error: "비밀번호가 일치하지 않습니다." });

        const tokenHash = await hashToken(token);
        const now = new Date();

        const [record] = await db
            .select({ id: passwordResetTokens.id, userId: passwordResetTokens.userId, expiresAt: passwordResetTokens.expiresAt })
            .from(passwordResetTokens)
            .where(and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(passwordResetTokens.usedAt)))
            .limit(1);

        if (!record || record.expiresAt < now) return fail(400, { error: "링크가 만료되었거나 이미 사용된 링크입니다." });

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

        throw redirect(302, resolve("/login") + "?passwordReset=1");
    },
};

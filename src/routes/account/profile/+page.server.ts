import { fail, redirect } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { users } from "$lib/server/db/schema";
import { getUserMembership } from "$lib/server/org/membership";
import { issueEmailVerification } from "$lib/server/auth/email-verification";
import { checkRateLimit } from "$lib/server/ratelimit";
import { translate } from "$lib/i18n/server";

export const load: PageServerLoad = async ({ locals }) => {
    if (!locals.user) throw redirect(303, "/login");
    const { db } = requireDbContext(locals);

    const membership = await getUserMembership(db, locals.user.id);

    return {
        profile: {
            displayName: locals.user.displayName,
            givenName: locals.user.givenName,
            familyName: locals.user.familyName,
            phoneNumber: locals.user.phoneNumber,
            avatarUrl: locals.user.avatarUrl,
            locale: locals.user.locale,
            zoneinfo: locals.user.zoneinfo,
            bio: locals.user.bio,
            birthdate: locals.user.birthdate,
        },
        email: locals.user.email,
        emailVerified: !!locals.user.emailVerifiedAt,
        membership,
    };
};

export const actions: Actions = {
    save: async ({ locals, request }) => {
        if (!locals.user) throw redirect(303, "/login");
        const { db, tenant } = requireDbContext(locals);

        const fd = await request.formData();
        const displayName = String(fd.get("displayName") ?? "").trim() || null;
        const givenName = String(fd.get("givenName") ?? "").trim() || null;
        const familyName = String(fd.get("familyName") ?? "").trim() || null;
        const phoneNumber = String(fd.get("phoneNumber") ?? "").trim() || null;
        const bio = String(fd.get("bio") ?? "").trim() || null;
        const birthdate = String(fd.get("birthdate") ?? "").trim() || null;
        const locale = String(fd.get("locale") ?? "ko-KR").trim();
        const zoneinfo = String(fd.get("zoneinfo") ?? "Asia/Seoul").trim();

        // birthdate 형식 검증 (YYYY-MM-DD)
        if (birthdate && !/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
            return fail(400, { error: "생년월일 형식이 올바르지 않습니다. (YYYY-MM-DD)" });
        }

        await db
            .update(users)
            .set({
                displayName,
                givenName,
                familyName,
                phoneNumber,
                bio,
                birthdate,
                locale,
                zoneinfo,
                updatedAt: new Date(),
            })
            .where(and(eq(users.id, locals.user.id), eq(users.tenantId, tenant.id)));

        return { success: true };
    },

    // 이메일 인증 메일 재발송. 이미 인증됐으면 no-op. rate-limit(기존 인프라 재사용).
    resendVerification: async (event) => {
        const { locals } = event;
        if (!locals.user) throw redirect(303, "/login");
        const { db, rateLimitStore } = requireDbContext(locals);
        const locale = locals.locale;

        // 이미 인증된 계정은 조용히 no-op(성공 응답).
        if (locals.user.emailVerifiedAt) {
            return { resent: true };
        }

        const rl = await checkRateLimit(rateLimitStore, `resend-verification:${locals.user.id}`, { windowMs: 60 * 60 * 1000, limit: 5 });
        if (!rl.allowed) {
            return fail(429, { resendError: translate(locale, "errors.rate_limit", { minutes: Math.ceil(rl.retryAfterMs / 60000) }) });
        }

        await issueEmailVerification(db, locals.user.id, locals.user.email, event.platform);
        return { resent: true };
    },
};

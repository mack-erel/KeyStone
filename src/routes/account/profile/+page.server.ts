import { fail, redirect } from "@sveltejs/kit";
import { and, eq, ne } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { users } from "$lib/server/db/schema";
import { getUserMembership } from "$lib/server/org/membership";
import { issueEmailVerification } from "$lib/server/auth/email-verification";
import { issueEmailChange } from "$lib/server/auth/email-change";
import { findPasswordCredential } from "$lib/server/auth/users";
import { verifyPassword } from "$lib/server/auth/password";
import { dispatchSecurityAlert } from "$lib/server/security-notify";
import { checkRateLimit } from "$lib/server/ratelimit";
import { translate } from "$lib/i18n/server";
import { normalizeLocale } from "$lib/i18n/core";

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
        // F3: 확인 대기 중인 새 이메일(있으면). UI 통합은 별도(profile.svelte 는 다른 에이전트 범위).
        pendingEmail: locals.user.pendingEmail,
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
            return fail(400, { error: translate(locals.locale, "profile.err_birthdate_format") });
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

        // 수신자(=본인) locale 우선. users.locale 없으면 요청 locale 로 폴백.
        await issueEmailVerification(db, locals.user.id, locals.user.email, normalizeLocale(locals.user.locale ?? locale), event.platform);
        return { resent: true };
    },

    // F3: 이메일 주소 변경 요청. 현 비밀번호 재인증 → 형식·중복 검증 → pendingEmail 저장 +
    // 변경 토큰 발급(새 주소로 확인 메일) + 기존 주소로 "변경 시도" 보안 알림. 실제 교체는
    // confirm-email-change 라우트에서 토큰 확인 시 일어난다.
    changeEmail: async (event) => {
        const { locals } = event;
        if (!locals.user) throw redirect(303, "/login");
        const { db, tenant, rateLimitStore } = requireDbContext(locals);
        const locale = locals.locale;
        const user = locals.user;

        const fd = await event.request.formData();
        const newEmail = String(fd.get("newEmail") ?? "")
            .trim()
            .toLowerCase();
        const password = String(fd.get("password") ?? "");

        // 토큰 제출/재인증 브루트포스 방어 — 계정 단위 rate-limit.
        const rl = await checkRateLimit(rateLimitStore, `change-email:${user.id}`, { windowMs: 60 * 60 * 1000, limit: 5 });
        if (!rl.allowed) {
            return fail(429, { changeEmailError: translate(locale, "errors.rate_limit", { minutes: Math.ceil(rl.retryAfterMs / 60000) }) });
        }

        // ── 현 비밀번호 재인증(step-up) — 세션 탈취 공격자가 이메일을 바꿔치기하지 못하게. ──
        const pwCred = await findPasswordCredential(db, user.id);
        if (!pwCred?.secret) {
            return fail(400, { changeEmailError: translate(locale, "profile.err_email_change_no_password") });
        }
        const pw = await verifyPassword(password, pwCred.secret);
        if (!pw.valid) {
            return fail(400, { changeEmailError: translate(locale, "profile.err_email_change_password") });
        }

        // ── 새 이메일 형식·동일·중복 검증(signup 과 동일 정규식). ──
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
            return fail(400, { changeEmailError: translate(locale, "profile.err_email_change_format") });
        }
        if (newEmail === user.email.toLowerCase()) {
            return fail(400, { changeEmailError: translate(locale, "profile.err_email_change_same") });
        }
        const [taken] = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.tenantId, tenant.id), eq(users.email, newEmail), ne(users.id, user.id)))
            .limit(1);
        if (taken) {
            return fail(409, { changeEmailError: translate(locale, "profile.err_email_change_taken") });
        }

        const now = new Date();
        // pendingEmail 대기 상태 기록(감사/UI 용). 실제 email 교체는 confirm 시점.
        await db
            .update(users)
            .set({ pendingEmail: newEmail, pendingEmailRequestedAt: now, updatedAt: now })
            .where(and(eq(users.id, user.id), eq(users.tenantId, tenant.id)));

        // 새 주소로 확인 링크 메일(수신자 locale 우선, best-effort 격리).
        await issueEmailChange(db, user.id, newEmail, normalizeLocale(user.locale ?? locale), event.platform);

        // 기존 주소로 "변경 시도됨" 보안 알림(best-effort). 탈취 시 정당 소유자가 인지·차단하도록.
        dispatchSecurityAlert({ to: user.email, locale: user.locale, kind: "email_change_requested", when: now, platform: event.platform });

        return { changeEmailSent: true, pendingEmail: newEmail };
    },
};

import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getRequestMetadata, recordAuditEvent } from "$lib/server/audit";
import { requireDbContext } from "$lib/server/auth/guards";
import { authenticateLocalUser, hasTotpCredential, normalizeUsername } from "$lib/server/auth/users";
import { createMfaPendingToken, MFA_PENDING_COOKIE } from "$lib/server/auth/mfa";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { checkRateLimit } from "$lib/server/ratelimit";

function sanitizeRedirectTarget(target: string | null): string | null {
    if (!target) return null;
    let decoded: string;
    try {
        decoded = decodeURIComponent(target);
    } catch {
        return null;
    }
    if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) {
        return null;
    }
    return target;
}

export const load: PageServerLoad = async ({ locals, url }) => {
    if (locals.user) {
        throw redirect(302, locals.user.role === "admin" ? "/admin" : "/");
    }

    return {
        redirectTo: sanitizeRedirectTarget(url.searchParams.get("redirectTo")),
        dbReady: Boolean(locals.db),
        runtimeError: locals.runtimeError,
    };
};

export const actions: Actions = {
    default: async (event) => {
        const formData = await event.request.formData();
        const username = normalizeUsername(String(formData.get("username") ?? ""));
        const password = String(formData.get("password") ?? "");
        const redirectTo = sanitizeRedirectTarget(String(formData.get("redirectTo") ?? ""));

        if (!username || !password) {
            return fail(400, {
                username,
                redirectTo,
                error: "아이디와 비밀번호를 입력해 주세요.",
            });
        }

        if (!event.locals.db || !event.locals.tenant) {
            return fail(503, {
                username,
                redirectTo,
                error: event.locals.runtimeError ?? 'D1 binding "DB" 가 준비되지 않았습니다. Wrangler preview/dev 환경에서 실행해 주세요.',
            });
        }

        const { db, tenant } = requireDbContext(event.locals);
        const requestMetadata = getRequestMetadata(event);

        // 레이트 리밋: IP당 10회/15분
        const rlKey = `admin-login:${requestMetadata.ip ?? "unknown"}`;
        const rl = await checkRateLimit(db, rlKey, { windowMs: 15 * 60 * 1000, limit: 10 });
        if (!rl.allowed) {
            return fail(429, {
                username,
                redirectTo,
                error: `로그인 시도가 너무 많습니다. ${Math.ceil(rl.retryAfterMs / 60000)}분 후 다시 시도해 주세요.`,
            });
        }

        const user = await authenticateLocalUser(db, tenant.id, username, password);

        if (!user) {
            await recordAuditEvent(db, {
                tenantId: tenant.id,
                kind: "login",
                outcome: "failure",
                ip: requestMetadata.ip,
                userAgent: requestMetadata.userAgent,
                detail: { username, via: "admin-login" },
            });

            return fail(400, {
                username,
                redirectTo,
                error: "아이디 또는 비밀번호가 올바르지 않습니다.",
            });
        }

        // 관리자 권한 확인
        if (user.role !== "admin") {
            await recordAuditEvent(db, {
                tenantId: tenant.id,
                userId: user.id,
                actorId: user.id,
                kind: "login",
                outcome: "failure",
                ip: requestMetadata.ip,
                userAgent: requestMetadata.userAgent,
                detail: { username, reason: "not_admin", via: "admin-login" },
            });

            return fail(403, {
                username,
                redirectTo,
                error: "관리자 권한이 없는 계정입니다.",
            });
        }

        const config = getRuntimeConfig(event.platform);
        if (!config.signingKeySecret) {
            return fail(503, {
                username,
                redirectTo,
                error: "MFA 설정 오류: IDP_SIGNING_KEY_SECRET 이 설정되지 않았습니다.",
            });
        }

        if (!(await hasTotpCredential(db, user.id))) {
            await recordAuditEvent(db, {
                tenantId: tenant.id,
                userId: user.id,
                actorId: user.id,
                kind: "login",
                outcome: "failure",
                ip: requestMetadata.ip,
                userAgent: requestMetadata.userAgent,
                detail: { username, reason: "mfa_not_configured", via: "admin-login" },
            });
            return fail(403, {
                username,
                redirectTo,
                error: "관리자 계정은 MFA(OTP) 설정이 필수입니다. 먼저 MFA를 등록해 주세요.",
            });
        }

        const mfaToken = await createMfaPendingToken(
            {
                userId: user.id,
                tenantId: tenant.id,
                redirectTo: redirectTo ?? "/admin",
                ip: requestMetadata.ip,
            },
            config.signingKeySecret,
        );

        event.cookies.set(MFA_PENDING_COOKIE, mfaToken, {
            path: "/",
            httpOnly: true,
            sameSite: "lax",
            secure: event.url.protocol === "https:",
            maxAge: 5 * 60,
        });

        throw redirect(303, "/mfa");
    },
};

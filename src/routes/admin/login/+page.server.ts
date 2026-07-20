import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getRequestMetadata, recordAuditEvent } from "$lib/server/audit";
import { requireDbContext } from "$lib/server/auth/guards";
import { authenticateLocalUser, hasTotpCredential, normalizeUsername } from "$lib/server/auth/users";
import { createMfaPendingToken, MFA_PENDING_COOKIE } from "$lib/server/auth/mfa";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { checkRateLimit, peekRateLimit } from "$lib/server/ratelimit";
import { translate } from "$lib/i18n/server";
import { adminError } from "$lib/server/admin/errors";

// ctrls M-8: admin 로그인도 사용자 로그인과 동일하게 계정 단위 잠금을 둔다(15분/10회).
// 다수 IP 에서의 admin 계정 패스워드 스프레이를 차단한다. 사용자 로그인(M-2)과 동일한
// "올바른 비밀번호는 항상 통과" 모델 — 잠금 상태여도 인증을 수행하고 실패한 경우에만 잠금 응답.
const ADMIN_LOCK_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOCK_LIMIT = 10;

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
        const locale = event.locals.locale;

        if (!username || !password) {
            return fail(400, {
                username,
                redirectTo,
                error: adminError(locale, "login_missing_credentials"),
            });
        }

        if (!event.locals.db || !event.locals.tenant) {
            return fail(503, {
                username,
                redirectTo,
                error: event.locals.runtimeError ?? translate(locale, "errors.db_not_ready"),
            });
        }

        const { db, tenant, rateLimitStore } = requireDbContext(event.locals);
        const requestMetadata = getRequestMetadata(event);

        // 레이트 리밋: IP당 10회/15분
        const rlKey = `admin-login:${requestMetadata.ipKey}`;
        const rl = await checkRateLimit(rateLimitStore, rlKey, { windowMs: 15 * 60 * 1000, limit: 10 });
        if (!rl.allowed) {
            return fail(429, {
                username,
                redirectTo,
                error: adminError(locale, "login_rate_limit", { minutes: Math.ceil(rl.retryAfterMs / 60000) }),
            });
        }

        // 계정 단위 잠금(M-8). 증가 없이 조회만 하고(성공 미카운트), 실패 분기에서만 기록한다.
        const userLockKey = `admin-login:user:${username}`;
        const lock = await peekRateLimit(rateLimitStore, userLockKey, { windowMs: ADMIN_LOCK_WINDOW_MS, limit: ADMIN_LOCK_LIMIT });
        const accountLocked = !lock.allowed;

        const user = await authenticateLocalUser(db, tenant.id, username, password);

        if (!user) {
            await checkRateLimit(rateLimitStore, userLockKey, { windowMs: ADMIN_LOCK_WINDOW_MS, limit: ADMIN_LOCK_LIMIT });
            await recordAuditEvent(db, {
                tenantId: tenant.id,
                kind: "login",
                outcome: "failure",
                ip: requestMetadata.ip,
                userAgent: requestMetadata.userAgent,
                detail: accountLocked ? { username, via: "admin-login", reason: "account_locked" } : { username, via: "admin-login" },
            });

            // 올바른 비밀번호였다면 user 가 채워져 이 분기에 오지 않으므로 정상 관리자는 차단되지 않는다.
            if (accountLocked) {
                return fail(429, {
                    username,
                    redirectTo,
                    error: adminError(locale, "login_account_locked", { minutes: Math.ceil(lock.retryAfterMs / 60000) }),
                });
            }

            return fail(400, {
                username,
                redirectTo,
                error: adminError(locale, "login_invalid_credentials"),
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
                error: adminError(locale, "login_not_admin"),
            });
        }

        const config = getRuntimeConfig(event.platform);
        if (!config.signingKeySecret) {
            return fail(503, {
                username,
                redirectTo,
                error: adminError(locale, "login_mfa_config"),
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
                error: adminError(locale, "login_mfa_required"),
            });
        }

        const mfaToken = await createMfaPendingToken(
            {
                userId: user.id,
                tenantId: tenant.id,
                redirectTo: redirectTo ?? "/admin",
                ip: requestMetadata.ip,
                // admin 로그인은 신뢰 기기 예외 — 항상 TOTP 를 요구하고 신뢰 기기 등록도 막는다.
                forced: true,
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

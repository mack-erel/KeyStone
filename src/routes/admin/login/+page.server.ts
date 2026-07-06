import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getRequestMetadata, recordAuditEvent } from "$lib/server/audit";
import { requireDbContext } from "$lib/server/auth/guards";
import { authenticateLocalUser, hasTotpCredential, normalizeUsername } from "$lib/server/auth/users";
import { createMfaPendingToken, MFA_PENDING_COOKIE } from "$lib/server/auth/mfa";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { checkRateLimit } from "$lib/server/ratelimit";
import { translate } from "$lib/i18n/server";
import { adminError } from "$lib/server/admin/errors";

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

        const { db, tenant } = requireDbContext(event.locals);
        const requestMetadata = getRequestMetadata(event);

        // 레이트 리밋: IP당 10회/15분
        const rlKey = `admin-login:${requestMetadata.ipKey}`;
        const rl = await checkRateLimit(db, rlKey, { windowMs: 15 * 60 * 1000, limit: 10 });
        if (!rl.allowed) {
            return fail(429, {
                username,
                redirectTo,
                error: adminError(locale, "login_rate_limit", { minutes: Math.ceil(rl.retryAfterMs / 60000) }),
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

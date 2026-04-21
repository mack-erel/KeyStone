import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getRequestMetadata, recordAuditEvent } from "$lib/server/audit";
import { requireDbContext } from "$lib/server/auth/guards";
import { createSessionRecord, setSessionCookie } from "$lib/server/auth/session";
import { authenticateLocalUser, hasTotpCredential, normalizeUsername } from "$lib/server/auth/users";
import { createMfaPendingToken, MFA_PENDING_COOKIE } from "$lib/server/auth/mfa";
import { AMR_PASSWORD, amrToAcr } from "$lib/server/auth/constants";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { checkRateLimit } from "$lib/server/ratelimit";
import { and, eq } from "drizzle-orm";
import { identityProviders } from "$lib/server/db/schema";
import { authenticateLdap } from "$lib/server/ldap/auth";
import { provisionLdapUser } from "$lib/server/ldap/provision";
import type { LdapProviderConfig } from "$lib/server/ldap/types";
import { decryptSecret } from "$lib/server/crypto/keys";
import { resolveSkinHtml, replacePlaceholders, escapeHtml } from "$lib/server/skin/resolver";

function sanitizeRedirectTarget(target: string | null): string | null {
    if (!target) return null;
    // URL 디코딩 후 재검사 — /%2f, /\ 등 우회 패턴 차단
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

export const load: PageServerLoad = async ({ locals, url, platform }) => {
    // forceAuthn=true 이면 이미 로그인된 사용자도 재인증을 진행해야 하므로 자동 리다이렉트 생략
    const forceAuthn = url.searchParams.get("forceAuthn") === "true";
    if (locals.user && !forceAuthn) {
        throw redirect(302, locals.user.role === "admin" ? "/admin" : "/");
    }

    const redirectTo = sanitizeRedirectTarget(url.searchParams.get("redirectTo"));
    const skinHint = url.searchParams.get("skinHint");
    let skinHtml: string | null = null;

    if (skinHint && locals.db && locals.tenant) {
        const colonIdx = skinHint.indexOf(":");
        if (colonIdx > 0) {
            const clientType = skinHint.slice(0, colonIdx) as "oidc" | "saml";
            const clientRefId = skinHint.slice(colonIdx + 1);
            if ((clientType === "oidc" || clientType === "saml") && clientRefId) {
                const raw = await resolveSkinHtml(locals.db, platform, locals.tenant.id, clientType, clientRefId);
                if (raw) {
                    skinHtml = replacePlaceholders(raw, {
                        IDP_FORM_ACTION: "",
                        IDP_REDIRECT_TO: escapeHtml(redirectTo ?? ""),
                        IDP_SKIN_HINT: escapeHtml(skinHint),
                    });
                }
            }
        }
    }

    return {
        redirectTo,
        skinHint,
        skinHtml,
        dbReady: Boolean(locals.db),
        runtimeError: locals.runtimeError,
        registered: url.searchParams.get("registered") === "1",
        passwordReset: url.searchParams.get("passwordReset") === "1",
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
        const rlKey = `login:${requestMetadata.ip ?? "unknown"}`;
        const rl = await checkRateLimit(db, rlKey, { windowMs: 15 * 60 * 1000, limit: 10 });
        if (!rl.allowed) {
            return fail(429, {
                username,
                redirectTo,
                error: `로그인 시도가 너무 많습니다. ${Math.ceil(rl.retryAfterMs / 60000)}분 후 다시 시도해 주세요.`,
            });
        }

        // LDAP 프로바이더가 설정된 경우 먼저 시도
        const [ldapProvider] = await db
            .select()
            .from(identityProviders)
            .where(and(eq(identityProviders.tenantId, tenant.id), eq(identityProviders.kind, "ldap"), eq(identityProviders.enabled, true)))
            .limit(1);

        let user = null;

        if (ldapProvider) {
            const ldapConfig = JSON.parse(ldapProvider.configJson ?? "{}") as LdapProviderConfig;

            // 암호화된 bindPassword 가 있으면 복호화 (레거시 평문 bindPassword 는 그대로 사용)
            const config = getRuntimeConfig(event.platform);
            if (ldapConfig.bindPasswordEnc && !ldapConfig.bindPassword && config.signingKeySecret) {
                try {
                    ldapConfig.bindPassword = await decryptSecret(ldapConfig.bindPasswordEnc, config.signingKeySecret, "idp-ldap-bind-password-v1");
                } catch {
                    // 복호화 실패 시 인증 진행 불가 — bindPassword 없이 진행하면 null 반환됨
                }
            }

            const ldapAttrs = await authenticateLdap(ldapConfig, username, password);

            if (ldapAttrs) {
                user = await provisionLdapUser(db, tenant.id, ldapProvider.id, ldapAttrs);
            }
        }

        // LDAP 미설정 또는 LDAP 인증 실패 시 로컬 인증 시도
        if (!user) {
            user = await authenticateLocalUser(db, tenant.id, username, password);
        }

        if (!user) {
            await recordAuditEvent(db, {
                tenantId: tenant.id,
                kind: "login",
                outcome: "failure",
                ip: requestMetadata.ip,
                userAgent: requestMetadata.userAgent,
                detail: { username },
            });

            return fail(400, {
                username,
                redirectTo,
                error: "아이디 또는 비밀번호가 올바르지 않습니다.",
            });
        }

        if (await hasTotpCredential(db, user.id)) {
            // MFA 단계로 진행
            const config = getRuntimeConfig(event.platform);
            if (!config.signingKeySecret) {
                return fail(503, {
                    username,
                    redirectTo,
                    error: "MFA 설정 오류: IDP_SIGNING_KEY_SECRET 이 설정되지 않았습니다.",
                });
            }

            const mfaToken = await createMfaPendingToken({ userId: user.id, tenantId: tenant.id, redirectTo, ip: requestMetadata.ip }, config.signingKeySecret);

            event.cookies.set(MFA_PENDING_COOKIE, mfaToken, {
                path: "/",
                httpOnly: true,
                sameSite: "lax",
                secure: event.url.protocol === "https:",
                maxAge: 5 * 60, // 5분
            });

            throw redirect(303, "/mfa");
        }

        // MFA 없음 — 세션 바로 생성
        const { sessionToken, expiresAt } = await createSessionRecord(db, {
            tenantId: tenant.id,
            userId: user.id,
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            amr: [AMR_PASSWORD],
            acr: amrToAcr([AMR_PASSWORD]),
        });

        setSessionCookie(event.cookies, event.url, sessionToken, expiresAt);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: user.id,
            actorId: user.id,
            kind: "login",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
        });

        throw redirect(303, user.role === "admin" ? (redirectTo ?? "/admin") : (redirectTo ?? "/"));
    },
};

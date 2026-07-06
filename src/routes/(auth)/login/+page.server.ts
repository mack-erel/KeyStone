import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getRequestMetadata, recordAuditEvent } from "$lib/server/audit";
import { requireDbContext } from "$lib/server/auth/guards";
import { createSessionRecord, revokeOtherSessions, setSessionCookie } from "$lib/server/auth/session";
import { authenticateLocalUser, authenticatePendingDeletionUser, hasTotpCredential, normalizeUsername } from "$lib/server/auth/users";
import { createMfaPendingToken, MFA_PENDING_COOKIE } from "$lib/server/auth/mfa";
import { AMR_PASSWORD, amrToAcr } from "$lib/server/auth/constants";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { checkRateLimit } from "$lib/server/ratelimit";
import { and, eq } from "drizzle-orm";
import type { DB } from "$lib/server/db";
import { identityProviders, rateLimits, users } from "$lib/server/db/schema";
import { authenticateLdap } from "$lib/server/ldap/auth";
import { provisionLdapUser } from "$lib/server/ldap/provision";
import type { LdapProviderConfig } from "$lib/server/ldap/types";
import { decryptSecret, encryptSecret, tryWithSecrets } from "$lib/server/crypto/keys";
import { resolveSkinHtml, replacePlaceholders, escapeHtml } from "$lib/server/skin/resolver";
import { sanitizeRedirectTarget } from "$lib/server/auth/redirect";
import { translate } from "$lib/i18n/server";

// S2(계정 단위 잠금): IP 무관하게 동일 계정에 대한 연속 실패를 제한한다. 임계값은 보수적으로
// 15분 창 10회 실패. 성공 로그인은 카운트하지 않고(오탐 최소화), 실패 분기에서만 checkRateLimit
// 으로 기록한다. 미존재 계정도 제출된 username 키로 동일하게 카운트/응답하므로 사용자 열거
// 오라클을 만들지 않는다.
const USER_LOCK_WINDOW_MS = 15 * 60 * 1000;
const USER_LOCK_LIMIT = 10;

// checkRateLimit(두 버킷 슬라이딩 윈도우)의 키/윈도우 규약을 증가 없이 read-only 로 재현한다.
// checkRateLimit 은 호출 시 카운터를 선증가시켜 "성공 미카운트 + 실패 시에만 기록" 요건과
// 충돌하므로, 상단 잠금 판정에는 증가 없는 조회를 쓰고 실제 기록은 실패 분기에서만 수행한다.
async function accountLockStatus(db: DB, key: string, windowMs: number, limit: number): Promise<{ locked: boolean; retryAfterMs: number }> {
    const now = Date.now();
    const windowIndex = Math.floor(now / windowMs);
    const windowStart = windowIndex * windowMs;
    const elapsed = now - windowStart;

    const [cur] = await db
        .select({ count: rateLimits.count })
        .from(rateLimits)
        .where(eq(rateLimits.key, `${key}:${windowIndex}`))
        .limit(1);
    const [prev] = await db
        .select({ count: rateLimits.count })
        .from(rateLimits)
        .where(eq(rateLimits.key, `${key}:${windowIndex - 1}`))
        .limit(1);

    const slidingCount = Math.floor((prev?.count ?? 0) * (1 - elapsed / windowMs)) + (cur?.count ?? 0);
    const locked = slidingCount > limit;
    return { locked, retryAfterMs: locked ? windowMs - elapsed : 0 };
}

async function resolveSkinForAction(event: Parameters<Actions["default"]>[0], flashMsg: string, redirectTo: string | null): Promise<string | null> {
    const skinHint = event.url.searchParams.get("skinHint");
    if (!skinHint || !event.locals.db || !event.locals.tenant) return null;
    const colonIdx = skinHint.indexOf(":");
    if (colonIdx <= 0) return null;
    const clientType = skinHint.slice(0, colonIdx) as "oidc" | "saml";
    const clientRefId = skinHint.slice(colonIdx + 1);
    if ((clientType !== "oidc" && clientType !== "saml") || !clientRefId) return null;
    const raw = await resolveSkinHtml(event.locals.db, event.platform, event.locals.tenant.id, clientType, clientRefId, "login");
    if (!raw) return null;
    return replacePlaceholders(raw, {
        IDP_FORM_ACTION: "",
        IDP_REDIRECT_TO: escapeHtml(redirectTo ?? ""),
        IDP_SKIN_HINT: escapeHtml(skinHint),
        IDP_REGISTERED: "",
        IDP_PASSWORD_RESET: "",
        IDP_FLASH_MSG: escapeHtml(flashMsg),
    });
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
                    const registered = url.searchParams.get("registered") === "1";
                    const passwordReset = url.searchParams.get("passwordReset") === "1";
                    skinHtml = replacePlaceholders(raw, {
                        IDP_FORM_ACTION: "",
                        IDP_REDIRECT_TO: escapeHtml(redirectTo ?? ""),
                        IDP_SKIN_HINT: escapeHtml(skinHint),
                        IDP_REGISTERED: registered ? "1" : "",
                        IDP_PASSWORD_RESET: passwordReset ? "1" : "",
                        IDP_FLASH_MSG: "",
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
        deletionRequested: url.searchParams.get("deletionRequested") === "1",
        // OIDC login_hint 전달 시 아이디 입력란 프리필용.
        loginHint: url.searchParams.get("loginHint")?.trim() || null,
    };
};

export const actions: Actions = {
    default: async (event) => {
        const formData = await event.request.formData();
        const username = normalizeUsername(String(formData.get("username") ?? ""));
        const password = String(formData.get("password") ?? "");
        const redirectTo = sanitizeRedirectTarget(String(formData.get("redirectTo") ?? ""));
        // 탈퇴 예정 계정 복구 확인 흐름의 2단계 제출 표식(1=복구 확정).
        const recover = String(formData.get("recover") ?? "") === "1";
        const locale = event.locals.locale;

        if (!username || !password) {
            const msg = translate(locale, "login.err_missing_credentials");
            return fail(400, {
                username,
                redirectTo,
                error: msg,
                skinHtml: await resolveSkinForAction(event, msg, redirectTo),
            });
        }

        if (!event.locals.db || !event.locals.tenant) {
            const msg = event.locals.runtimeError ?? translate(locale, "errors.db_not_ready");
            return fail(503, {
                username,
                redirectTo,
                error: msg,
                skinHtml: await resolveSkinForAction(event, msg, redirectTo),
            });
        }

        const { db, tenant } = requireDbContext(event.locals);
        const requestMetadata = getRequestMetadata(event);

        // 레이트 리밋: IP당 10회/15분
        const rlKey = `login:${requestMetadata.ipKey}`;
        const rl = await checkRateLimit(db, rlKey, { windowMs: 15 * 60 * 1000, limit: 10 });
        if (!rl.allowed) {
            const msg = translate(locale, "login.err_rate_limit", { minutes: Math.ceil(rl.retryAfterMs / 60000) });
            return fail(429, {
                username,
                redirectTo,
                error: msg,
                skinHtml: await resolveSkinForAction(event, msg, redirectTo),
            });
        }

        // 계정 단위 잠금(S2): 인증 시도 전에 잠금 여부를 증가 없이 조회해 조기 차단한다.
        // (LDAP/로컬 인증 이전이라 두 경로 모두 보호되고, 잠긴 계정은 올바른 비밀번호로도
        //  진입할 수 없어 scrypt 비용 낭비와 열거 오라클을 함께 차단한다.)
        const userLockKey = `login:user:${username}`;
        const lock = await accountLockStatus(db, userLockKey, USER_LOCK_WINDOW_MS, USER_LOCK_LIMIT);
        if (lock.locked) {
            await recordAuditEvent(db, {
                tenantId: tenant.id,
                kind: "login",
                outcome: "failure",
                ip: requestMetadata.ip,
                userAgent: requestMetadata.userAgent,
                detail: { username, reason: "account_locked" },
            });
            const msg = translate(locale, "login.err_account_locked", { minutes: Math.ceil(lock.retryAfterMs / 60000) });
            return fail(429, {
                username,
                redirectTo,
                error: msg,
                skinHtml: await resolveSkinForAction(event, msg, redirectTo),
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
            if (ldapConfig.bindPasswordEnc && !ldapConfig.bindPassword && config.signingKeySecrets.length > 0) {
                try {
                    // 무중단 회전: previous 로 암호화된 bindPassword 도 복호되도록 fallback.
                    ldapConfig.bindPassword = await tryWithSecrets(config.signingKeySecrets, (s) => decryptSecret(ldapConfig.bindPasswordEnc!, s, "idp-ldap-bind-password-v1"));
                } catch {
                    // 복호화 실패 시 인증 진행 불가 — bindPassword 없이 진행하면 null 반환됨
                }
            } else if (ldapConfig.bindPassword && !ldapConfig.bindPasswordEnc) {
                // ctrls M-D: 레거시 평문 bindPassword 를 이번 로그인에서 즉시 암호화 마이그레이션한다.
                // (기존엔 warn 만 하고 평문을 계속 사용 → admin 재저장 전까지 평문이 DB 에 상주.)
                // 이번 요청의 bind 는 아래에서 평문으로 계속 진행하되, DB 에는 암호문만 남긴다.
                if (config.signingKeySecret) {
                    try {
                        const enc = await encryptSecret(ldapConfig.bindPassword, config.signingKeySecret, "idp-ldap-bind-password-v1");
                        const { bindPassword: _plain, ...rest } = ldapConfig;
                        void _plain;
                        const migrated = { ...rest, bindPasswordEnc: enc };
                        await db
                            .update(identityProviders)
                            .set({ configJson: JSON.stringify(migrated), updatedAt: new Date() })
                            .where(and(eq(identityProviders.id, ldapProvider.id), eq(identityProviders.tenantId, tenant.id)));
                    } catch {
                        // 마이그레이션 실패해도 이번 로그인은 평문으로 진행 (best-effort). 다음 로그인에서 재시도.
                        console.warn(`[ldap] provider ${ldapProvider.id} 평문 bindPassword 자동 암호화 실패 — admin 페이지에서 재저장 권장`);
                    }
                } else {
                    console.warn(`[ldap] provider ${ldapProvider.id} 에 평문 bindPassword 가 남아 있으나 IDP_SIGNING_KEY_SECRET 미설정으로 암호화 불가`);
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
            // 탈퇴 예정(soft-delete) 계정 복구 흐름. authenticateLocalUser 는 active 만 통과시키므로
            // deletion_pending 계정은 위에서 null 이 된다. 비밀번호가 맞으면(=본인) 복구 확인으로 분기한다.
            const pendingUser = await authenticatePendingDeletionUser(db, tenant.id, username, password);
            if (pendingUser) {
                const nowMs = Date.now();
                const scheduledMs = pendingUser.deletionScheduledAt ? new Date(pendingUser.deletionScheduledAt).getTime() : null;
                const withinGrace = scheduledMs !== null && scheduledMs > nowMs;

                if (!withinGrace) {
                    // 유예 경과 — GC 하드삭제 대상. 복구 불가, 로그인 거부.
                    await recordAuditEvent(db, {
                        tenantId: tenant.id,
                        userId: pendingUser.id,
                        kind: "login",
                        outcome: "failure",
                        ip: requestMetadata.ip,
                        userAgent: requestMetadata.userAgent,
                        detail: { username, reason: "deletion_grace_elapsed" },
                    });
                    const msg = translate(locale, "login.err_account_deleting");
                    return fail(400, { username, redirectTo, error: msg, skinHtml: await resolveSkinForAction(event, msg, redirectTo) });
                }

                if (!recover) {
                    // 1단계: 복구 확인 프롬프트를 띄운다(세션 생성/복구 없음). 사용자가 비밀번호를
                    // 다시 입력하고 recover=1 로 재제출하면 아래 2단계에서 실제 복구+로그인이 진행된다.
                    return { recovery: true as const, username, redirectTo };
                }

                // 2단계: 복구 확정 — 계정을 활성으로 환원하고 삭제 예정을 해제한 뒤 정상 로그인으로 진행.
                await db
                    .update(users)
                    .set({ status: "active", deletionScheduledAt: null, updatedAt: new Date() })
                    .where(and(eq(users.id, pendingUser.id), eq(users.tenantId, tenant.id)));
                await recordAuditEvent(db, {
                    tenantId: tenant.id,
                    userId: pendingUser.id,
                    actorId: pendingUser.id,
                    kind: "user_deletion_cancelled",
                    outcome: "success",
                    ip: requestMetadata.ip,
                    userAgent: requestMetadata.userAgent,
                });
                user = { ...pendingUser, status: "active", deletionScheduledAt: null };
            }
        }

        if (!user) {
            // 실패 시에만 카운트(성공은 미카운트). 미존재/존재-오답 모두 이 분기를 타므로
            // 동일하게 기록되어 열거 오라클을 만들지 않는다. 임계 초과는 다음 요청의
            // accountLockStatus 조기 차단에서 반영된다.
            await checkRateLimit(db, userLockKey, { windowMs: USER_LOCK_WINDOW_MS, limit: USER_LOCK_LIMIT });

            await recordAuditEvent(db, {
                tenantId: tenant.id,
                kind: "login",
                outcome: "failure",
                ip: requestMetadata.ip,
                userAgent: requestMetadata.userAgent,
                detail: { username },
            });

            const msg = translate(locale, "login.err_invalid_credentials");
            return fail(400, {
                username,
                redirectTo,
                error: msg,
                skinHtml: await resolveSkinForAction(event, msg, redirectTo),
            });
        }

        if (await hasTotpCredential(db, user.id)) {
            // MFA 단계로 진행
            const config = getRuntimeConfig(event.platform);
            if (!config.signingKeySecret) {
                const msg = translate(locale, "login.err_mfa_config");
                return fail(503, {
                    username,
                    redirectTo,
                    error: msg,
                    skinHtml: await resolveSkinForAction(event, msg, redirectTo),
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

            const skinHintParam = event.url.searchParams.get("skinHint");
            const mfaUrl = skinHintParam ? `/mfa?skinHint=${encodeURIComponent(skinHintParam)}` : "/mfa";
            throw redirect(303, mfaUrl);
        }

        // MFA 없음 — 세션 바로 생성
        const { sessionToken, expiresAt, sessionId } = await createSessionRecord(db, {
            tenantId: tenant.id,
            userId: user.id,
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            amr: [AMR_PASSWORD],
            acr: amrToAcr([AMR_PASSWORD]),
        });

        // 기존 세션 회수 — 새 세션만 살아남도록.
        await revokeOtherSessions(db, user.id, sessionId);

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

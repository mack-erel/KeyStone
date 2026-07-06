import { error, redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit";
import { findOidcClient, isAllowedRedirectUri, parseGrantedScopes } from "$lib/server/oidc/client";
import { createGrant } from "$lib/server/oidc/grant";
import { checkRateLimit } from "$lib/server/ratelimit";
import { hasServiceAccess } from "$lib/server/access/service-permissions";
import { verifyIdToken } from "$lib/server/crypto/keys";
import { resolveIssuerUrl } from "$lib/server/auth/runtime";
import { translate } from "$lib/i18n/server";

/** redirect_uri 가 확정된 이후에만 사용. 그 전 오류는 throw error() 로 직접 응답. */
function authRedirectError(redirectUri: string, errorCode: string, description: string, state?: string | null): never {
    const dest = new URL(redirectUri);
    dest.searchParams.set("error", errorCode);
    dest.searchParams.set("error_description", description);
    if (state) dest.searchParams.set("state", state);
    throw redirect(302, dest.toString());
}

export const GET: RequestHandler = async (event) => {
    const { locals, url } = event;
    const { db, tenant, rateLimitStore } = requireDbContext(locals);

    // IP당 60회/분 제한 — grant INSERT DoS 방지
    const { ip, ipKey } = getRequestMetadata(event);
    const rl = await checkRateLimit(rateLimitStore, `oidc-authorize:${ipKey}`, {
        windowMs: 60 * 1000,
        limit: 60,
    });
    if (!rl.allowed) {
        throw error(429, translate(locals.locale, "oidc.errors.rate_limited"));
    }

    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const responseType = url.searchParams.get("response_type");
    const scope = url.searchParams.get("scope") ?? "openid";
    const state = url.searchParams.get("state");
    const nonce = url.searchParams.get("nonce");
    const codeChallenge = url.searchParams.get("code_challenge");
    const codeChallengeMethod = url.searchParams.get("code_challenge_method");

    // client_id / redirect_uri 가 없으면 redirect 불가 → 직접 오류 응답
    if (!clientId || !redirectUri) {
        throw error(400, translate(locals.locale, "oidc.errors.client_id_redirect_uri_required"));
    }
    if (responseType !== "code") {
        throw error(400, translate(locals.locale, "oidc.errors.response_type_unsupported"));
    }

    const client = await findOidcClient(db, tenant.id, clientId);
    if (!client) {
        throw error(401, translate(locals.locale, "oidc.errors.unknown_client"));
    }

    if (!isAllowedRedirectUri(client, redirectUri)) {
        throw error(400, translate(locals.locale, "oidc.errors.redirect_uri_mismatch"));
    }

    // PKCE 검증
    // - 공개 클라이언트(tokenEndpointAuthMethod=none)는 PKCE 필수 (RFC 8252)
    // - code_challenge 가 빈 문자열이면 거부
    // - code_challenge 가 어떤 형태로든 제공되면 method 는 반드시 S256 만 허용
    const pkceRequired = client.requirePkce || client.tokenEndpointAuthMethod === "none";
    const hasChallenge = codeChallenge !== null && codeChallenge.trim().length > 0;

    if (pkceRequired && !hasChallenge) {
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            spOrClientId: clientId,
            kind: "oidc_authorize",
            outcome: "failure",
            ip,
            userAgent: getRequestMetadata(event).userAgent,
            detail: { error: "invalid_request", reason: "pkce_required" },
        });
        authRedirectError(redirectUri, "invalid_request", translate(locals.locale, "oidc.errors.pkce_required"), state);
    }
    if (codeChallenge !== null && !hasChallenge) {
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            spOrClientId: clientId,
            kind: "oidc_authorize",
            outcome: "failure",
            ip,
            userAgent: getRequestMetadata(event).userAgent,
            detail: { error: "invalid_request", reason: "empty_code_challenge" },
        });
        authRedirectError(redirectUri, "invalid_request", translate(locals.locale, "oidc.errors.empty_code_challenge"), state);
    }
    if (hasChallenge && codeChallengeMethod !== "S256") {
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            spOrClientId: clientId,
            kind: "oidc_authorize",
            outcome: "failure",
            ip,
            userAgent: getRequestMetadata(event).userAgent,
            detail: { error: "invalid_request", reason: "invalid_code_challenge_method", method: codeChallengeMethod },
        });
        authRedirectError(redirectUri, "invalid_request", translate(locals.locale, "oidc.errors.code_challenge_method_unsupported"), state);
    }

    // scope 검증
    const grantedScopes = parseGrantedScopes(client, scope);
    if (!grantedScopes.includes("openid")) {
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            spOrClientId: clientId,
            kind: "oidc_authorize",
            outcome: "failure",
            ip,
            userAgent: getRequestMetadata(event).userAgent,
            detail: { error: "invalid_scope", requestedScope: scope },
        });
        authRedirectError(redirectUri, "invalid_scope", translate(locals.locale, "oidc.errors.openid_scope_required"), state);
    }
    const grantedScope = grantedScopes.join(" ");

    // ── prompt / max_age / id_token_hint / login_hint (OIDC Core 3.1.2) ─────────
    const prompts = new Set((url.searchParams.get("prompt") ?? "").split(/\s+/).filter(Boolean));
    const promptNone = prompts.has("none");
    // prompt=none 은 다른 값과 함께 올 수 없다.
    if (promptNone && prompts.size > 1) {
        authRedirectError(redirectUri, "invalid_request", translate(locals.locale, "oidc.errors.prompt_none_conflict"), state);
    }

    const maxAgeRaw = url.searchParams.get("max_age");
    let maxAge: number | null = null;
    if (maxAgeRaw !== null) {
        const n = Number.parseInt(maxAgeRaw, 10);
        if (!Number.isFinite(n) || n < 0) {
            authRedirectError(redirectUri, "invalid_request", translate(locals.locale, "oidc.errors.max_age_invalid"), state);
        }
        maxAge = n;
    }

    const idTokenHint = url.searchParams.get("id_token_hint");
    const loginHint = url.searchParams.get("login_hint");

    const loggedIn = Boolean(locals.user && locals.session);

    // 재인증 필요 여부 (로그인된 경우에만 의미 있음): prompt=login, max_age 초과,
    // id_token_hint 의 sub 불일치.
    let reauthRequired = false;
    if (loggedIn) {
        if (prompts.has("login")) reauthRequired = true;
        if (!reauthRequired && maxAge !== null) {
            const authTimeSec = Math.floor(locals.session!.createdAt.getTime() / 1000);
            if (Math.floor(Date.now() / 1000) - authTimeSec > maxAge) reauthRequired = true;
        }
        if (!reauthRequired && idTokenHint) {
            const issuer = resolveIssuerUrl(locals.runtimeConfig, url.origin);
            // id_token_hint 는 만료돼 있는 것이 정상이므로 exp 검사는 건너뛰되 서명은 검증한다.
            const hintClaims = await verifyIdToken(db, tenant.id, idTokenHint, { expectedIssuer: issuer, ignoreExpiry: true });
            if (!hintClaims || hintClaims.sub !== locals.user!.id) reauthRequired = true;
        }
    }

    const needsInteraction = !loggedIn || reauthRequired;

    if (promptNone && needsInteraction) {
        // 무상호작용 요청인데 상호작용이 필요 → 표준 오류를 redirect_uri 로 반환.
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: locals.user?.id,
            spOrClientId: clientId,
            kind: "oidc_authorize",
            outcome: "failure",
            ip,
            userAgent: getRequestMetadata(event).userAgent,
            detail: { error: "login_required", reason: reauthRequired ? "reauth_required" : "not_authenticated" },
        });
        authRedirectError(redirectUri, "login_required", translate(locals.locale, "oidc.errors.login_required"), state);
    }

    if (needsInteraction) {
        // 인터랙티브 로그인/재인증으로 리다이렉트.
        const loginUrl = new URL("/login", url);
        loginUrl.searchParams.set("redirectTo", url.pathname + url.search);
        loginUrl.searchParams.set("skinHint", `oidc:${client.id}`);
        if (reauthRequired) loginUrl.searchParams.set("forceAuthn", "true");
        if (loginHint) loginUrl.searchParams.set("loginHint", loginHint);
        throw redirect(302, loginUrl.toString());
    }

    // 여기 도달 시 로그인 상태가 보장된다 (타입 좁히기용 방어 체크).
    if (!locals.user || !locals.session) {
        throw error(500, translate(locals.locale, "oidc.errors.session_missing_after_gate"));
    }

    // 서비스 권한 게이트 (기본 deny). 매핑 없으면 SSO 거부.
    const allowed = await hasServiceAccess(db, {
        tenantId: tenant.id,
        userId: locals.user.id,
        serviceType: "oidc",
        serviceRefId: client.id,
    });
    if (!allowed) {
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: locals.user.id,
            actorId: locals.user.id,
            spOrClientId: clientId,
            kind: "oidc_authorize",
            outcome: "failure",
            ip,
            userAgent: getRequestMetadata(event).userAgent,
            detail: { error: "access_denied", reason: "no_service_assignment" },
        });
        authRedirectError(redirectUri, "access_denied", translate(locals.locale, "oidc.errors.service_access_denied"), state);
    }

    // authorization code 발급
    const code = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

    await createGrant(db, {
        tenantId: tenant.id,
        clientId,
        userId: locals.user.id,
        sessionId: locals.session.id,
        code,
        codeChallenge: codeChallenge ?? null,
        codeChallengeMethod: (codeChallengeMethod as "S256" | "plain" | null) ?? null,
        redirectUri,
        scope: grantedScope,
        nonce: nonce ?? null,
        state: state ?? null,
        acr: locals.session.acr ?? null,
    });

    const { userAgent } = getRequestMetadata(event);
    await recordAuditEvent(db, {
        tenantId: tenant.id,
        userId: locals.user.id,
        actorId: locals.user.id,
        spOrClientId: clientId,
        kind: "oidc_authorize",
        outcome: "success",
        ip,
        userAgent,
        detail: { clientId, scope: grantedScope },
    });

    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set("code", code);
    if (state) callbackUrl.searchParams.set("state", state);
    throw redirect(302, callbackUrl.toString());
};

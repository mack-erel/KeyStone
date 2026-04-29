import type { Handle } from "@sveltejs/kit";
import { ensureAuthBaseline } from "$lib/server/auth/bootstrap";
import { SESSION_COOKIE_NAME, SESSION_TOUCH_INTERVAL_MS } from "$lib/server/auth/constants";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { clearSessionCookie, getSessionContext, touchSession } from "$lib/server/auth/session";
import { getDb } from "$lib/server/db";

// CSRF: state-changing 요청에 대해 same-origin을 강제할 라우트
const CSRF_PROTECTED = [
    /^\/admin(\/|$)/,
    /^\/account(\/|$)/,
    /^\/(login|signup|find-id|find-password|reset-password|mfa|logout)(\/|$)/,
    /^\/api\/webauthn\//,
];

// CSRF: 프로토콜 자체 인증으로 보호되므로 origin 검사를 건너뛸 라우트
const CSRF_SKIP = [
    /^\/saml\//, // SAML: 서명된 XML
    /^\/oidc\//, // OIDC: client_secret + PKCE + state
    /^\/api\/skin-scripts/,
];

// 인증/계정/관리자 등 캐시 금지 + COOP/CORP 적용 대상
const SENSITIVE = [
    /^\/admin/,
    /^\/account/,
    /^\/(login|signup|find-id|find-password|reset-password|mfa|logout)/,
    /^\/oidc\/(authorize|token|userinfo|end-session)/,
    /^\/api\/webauthn/,
];

// cross-origin 으로 노출되어야 하는 공개 메타데이터 (CORP 면제)
const PUBLIC_META = [/^\/\.well-known\//, /^\/oidc\/jwks/, /^\/saml\/metadata/];

export const handle: Handle = async ({ event, resolve }) => {
    event.locals.db = undefined;
    event.locals.tenant = null;
    event.locals.session = null;
    event.locals.user = null;
    event.locals.runtimeConfig = getRuntimeConfig(event.platform);
    event.locals.runtimeError = null;

    const path = event.url.pathname;

    // ── CSRF: 라우트별 same-origin 검사 ─────────────────────────────────────────
    if (event.request.method !== "GET" && event.request.method !== "HEAD") {
        const requireOrigin = CSRF_PROTECTED.some((r) => r.test(path)) && !CSRF_SKIP.some((r) => r.test(path));
        if (requireOrigin) {
            const origin = event.request.headers.get("origin");
            if (origin) {
                try {
                    if (new URL(origin).host !== event.url.host) {
                        return new Response("CSRF check failed", { status: 403 });
                    }
                } catch {
                    return new Response("CSRF check failed", { status: 403 });
                }
            } else {
                const referer = event.request.headers.get("referer");
                if (referer) {
                    try {
                        if (new URL(referer).host !== event.url.host) {
                            return new Response("CSRF check failed", { status: 403 });
                        }
                    } catch {
                        return new Response("CSRF check failed", { status: 403 });
                    }
                } else {
                    // Origin/Referer 모두 없는 state-changing 요청은 보호 라우트에서 거부
                    return new Response("CSRF check failed: missing origin", { status: 403 });
                }
            }
        }
    }

    // baseline 쿼리가 불필요한 경로 (정적 메타데이터, 헬스체크)
    const skipBaseline = path.startsWith("/.well-known/") || path === "/api/health" || path === "/favicon.ico" || path === "/robots.txt";

    try {
        if (event.platform?.env?.DB) {
            const db = await getDb(event.platform);
            event.locals.db = db;
            event.locals.tenant = skipBaseline ? null : await ensureAuthBaseline(db, event.platform);

            const sessionToken = event.cookies.get(SESSION_COOKIE_NAME);

            if (sessionToken) {
                const sessionContext = await getSessionContext(db, sessionToken);

                if (sessionContext) {
                    event.locals.session = sessionContext.session;
                    event.locals.user = sessionContext.user;

                    if (Date.now() - sessionContext.session.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
                        const now = new Date();
                        await touchSession(db, sessionContext.session.id, now);
                        event.locals.session.lastSeenAt = now;
                    }
                } else {
                    clearSessionCookie(event.cookies, event.url);
                }
            }
        }
    } catch (error) {
        event.locals.runtimeError = error instanceof Error ? error.message : "인증 컨텍스트 초기화 중 오류가 발생했습니다.";
        console.error(event.locals.runtimeError, error);
    }

    const response = await resolve(event);

    // ── 보안 헤더 ──────────────────────────────────────────────────────────────
    // Clickjacking 방지
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("X-Content-Type-Options", "nosniff");

    // Referrer 정책
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

    // HSTS (HTTPS 강제, 1년)
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

    // Permissions Policy — 불필요한 브라우저 기능 비활성화 + FLoC/Topics 차단
    response.headers.set(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=(), browsing-topics=()",
    );

    // 민감 라우트 캐시 금지
    if (SENSITIVE.some((r) => r.test(path))) {
        response.headers.set("Cache-Control", "no-store, private");
        response.headers.set("Pragma", "no-cache");
    }

    // COOP/CORP — 공개 메타데이터(JWKS, SAML metadata, .well-known) 제외하고 same-origin 강제
    if (!PUBLIC_META.some((r) => r.test(path))) {
        response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
        response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
    }

    // CSP는 svelte.config.js csp.mode='hash' 로 관리 (unsafe-inline 없는 해시 기반)

    return response;
};

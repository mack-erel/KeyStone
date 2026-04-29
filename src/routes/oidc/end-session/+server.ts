import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq } from "drizzle-orm";
import { oidcClients } from "$lib/server/db/schema";
import { clearSessionCookie, revokeSession } from "$lib/server/auth/session";
import { getActiveSigningKey, verifyIdToken } from "$lib/server/crypto/keys";
import { getOidcBackchannelTargets, getOidcFrontchannelTargets, sendOneBackchannelLogout } from "$lib/server/oidc/logout";

function htmlEscape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function renderFrontchannelLogoutHtml(iframeUris: string[], redirectTo: string): string {
    // iframe sandbox: allow-scripts 만 허용. allow-same-origin 은 RP 측 cookie 접근 차단을 위해 제거.
    const iframes = iframeUris.map((u) => `<iframe src="${htmlEscape(u)}" style="display:none" sandbox="allow-scripts"></iframe>`).join("");
    // CSP 는 hash 모드이므로 inline JS 를 피하고 meta refresh 를 사용한다.
    return (
        `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">` +
        `<title>Logging out...</title>` +
        `<meta http-equiv="refresh" content="3;url=${htmlEscape(redirectTo)}">` +
        `</head><body>` +
        `<p>로그아웃 중...</p>` +
        iframes +
        `</body></html>`
    );
}

function renderConfirmHtml(actionUrl: string, params: { idTokenHint: string; clientId: string; postLogoutRedirectUri: string | null; state: string | null }): string {
    const hidden = (name: string, value: string | null): string => (value ? `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">` : "");
    return (
        `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>로그아웃 확인</title></head><body>` +
        `<h1>로그아웃</h1><p>로그아웃하시겠습니까?</p>` +
        `<form method="POST" action="${htmlEscape(actionUrl)}">` +
        hidden("id_token_hint", params.idTokenHint) +
        hidden("client_id", params.clientId) +
        hidden("post_logout_redirect_uri", params.postLogoutRedirectUri) +
        hidden("state", params.state) +
        `<button type="submit">로그아웃</button>` +
        `</form></body></html>`
    );
}

async function resolvePostLogoutRedirect(locals: App.Locals, postLogoutRedirectUri: string | null, clientId: string | null, state: string | null): Promise<string> {
    if (!postLogoutRedirectUri || !clientId || !locals.db || !locals.tenant) return "/";
    const [client] = await locals.db
        .select({ postLogoutRedirectUris: oidcClients.postLogoutRedirectUris })
        .from(oidcClients)
        .where(and(eq(oidcClients.tenantId, locals.tenant.id), eq(oidcClients.clientId, clientId), eq(oidcClients.enabled, true)))
        .limit(1);
    if (!client?.postLogoutRedirectUris) return "/";
    let allowed: string[];
    try {
        allowed = JSON.parse(client.postLogoutRedirectUris) as string[];
    } catch {
        allowed = [];
    }
    if (Array.isArray(allowed) && allowed.includes(postLogoutRedirectUri)) {
        if (state) {
            const u = new URL(postLogoutRedirectUri);
            u.searchParams.set("state", state);
            return u.toString();
        }
        return postLogoutRedirectUri;
    }
    return "/";
}

export const GET: RequestHandler = async (event) => {
    const { locals, url } = event;
    const postLogoutRedirectUri = url.searchParams.get("post_logout_redirect_uri");
    const clientId = url.searchParams.get("client_id");
    const idTokenHint = url.searchParams.get("id_token_hint");
    const state = url.searchParams.get("state");

    // ctrls M-10: id_token_hint 가 없으면 거부 (CSRF / drive-by logout 방지)
    if (!idTokenHint) {
        return new Response(JSON.stringify({ error: "invalid_request", error_description: "id_token_hint 가 필요합니다." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    if (!locals.db || !locals.tenant) {
        return new Response(JSON.stringify({ error: "server_error" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
        });
    }

    const issuer = locals.runtimeConfig.issuerUrl ?? url.origin;
    const claims = await verifyIdToken(locals.db, locals.tenant.id, idTokenHint, { expectedIssuer: issuer });
    if (!claims) {
        return new Response(JSON.stringify({ error: "invalid_id_token_hint" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    // aud 검증: client_id 가 명시됐다면 정확히 일치해야 한다.
    if (clientId) {
        const aud = claims.aud;
        const audMatches = typeof aud === "string" ? aud === clientId : Array.isArray(aud) ? aud.includes(clientId) : false;
        if (!audMatches) {
            return new Response(JSON.stringify({ error: "invalid_id_token_hint", error_description: "aud mismatch" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }
    }
    if (locals.user && claims.sub !== locals.user.id) {
        return new Response(JSON.stringify({ error: "id_token_hint_mismatch" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    // GET 은 사용자 confirmation 페이지를 렌더한다 (CSRF 방지).
    // 실제 로그아웃은 POST 에서 수행된다.
    return new Response(
        renderConfirmHtml(url.pathname, {
            idTokenHint,
            clientId: clientId ?? "",
            postLogoutRedirectUri,
            state,
        }),
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
};

export const POST: RequestHandler = async (event) => {
    const { locals, url, cookies, request, platform } = event;

    // CSRF 방어: Origin 또는 Referer 가 동일 origin 이어야 함.
    const origin = request.headers.get("Origin");
    const referer = request.headers.get("Referer");
    const sameOrigin = (val: string | null): boolean => {
        if (!val) return false;
        try {
            return new URL(val).origin === url.origin;
        } catch {
            return false;
        }
    };
    if (!sameOrigin(origin) && !sameOrigin(referer)) {
        return new Response(JSON.stringify({ error: "invalid_request", error_description: "cross-origin POST 차단" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
        });
    }

    let postLogoutRedirectUri: string | null = null;
    let clientId: string | null = null;
    let idTokenHint: string | null = null;
    let state: string | null = null;
    const ct = request.headers.get("Content-Type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
        const form = await request.formData();
        postLogoutRedirectUri = (form.get("post_logout_redirect_uri") as string | null) ?? null;
        clientId = (form.get("client_id") as string | null) ?? null;
        idTokenHint = (form.get("id_token_hint") as string | null) ?? null;
        state = (form.get("state") as string | null) ?? null;
    } else {
        postLogoutRedirectUri = url.searchParams.get("post_logout_redirect_uri");
        clientId = url.searchParams.get("client_id");
        idTokenHint = url.searchParams.get("id_token_hint");
        state = url.searchParams.get("state");
    }

    if (!idTokenHint || !locals.db || !locals.tenant) {
        return new Response(JSON.stringify({ error: "invalid_request" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const issuer = locals.runtimeConfig.issuerUrl ?? url.origin;
    const claims = await verifyIdToken(locals.db, locals.tenant.id, idTokenHint, { expectedIssuer: issuer });
    if (!claims) {
        return new Response(JSON.stringify({ error: "invalid_id_token_hint" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    if (clientId) {
        const aud = claims.aud;
        const audMatches = typeof aud === "string" ? aud === clientId : Array.isArray(aud) ? aud.includes(clientId) : false;
        if (!audMatches) {
            return new Response(JSON.stringify({ error: "invalid_id_token_hint", error_description: "aud mismatch" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }
    }
    if (locals.user && claims.sub !== locals.user.id) {
        return new Response(JSON.stringify({ error: "id_token_hint_mismatch" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    // 세션이 있으면 BC/FC 로그아웃 타깃을 수집·발송한 뒤 세션을 폐기한다.
    if (locals.session && locals.user) {
        const db = locals.db;
        const tenantId = locals.tenant.id;
        const sessionId = locals.session.id;
        const idpSessionId = locals.session.idpSessionId;
        const userId = locals.user.id;

        const issuerUrl = locals.runtimeConfig.issuerUrl ?? url.origin;
        const signingKeySecret = locals.runtimeConfig.signingKeySecret;

        const bcTargets = await getOidcBackchannelTargets(db, tenantId, sessionId);
        const fcTargets = await getOidcFrontchannelTargets(db, tenantId, sessionId, idpSessionId, issuerUrl);

        if (bcTargets.length > 0 && signingKeySecret) {
            const signingKey = await getActiveSigningKey(db, tenantId, signingKeySecret);
            if (signingKey) {
                const bcPromises = bcTargets.map((t) => sendOneBackchannelLogout(t, userId, idpSessionId, issuerUrl, signingKey.privateKey, signingKey.kid).catch(() => undefined));
                const wait = platform?.ctx?.waitUntil?.bind(platform.ctx);
                if (wait) {
                    wait(Promise.all(bcPromises));
                } else {
                    await Promise.all(bcPromises);
                }
            }
        }

        await revokeSession(db, idpSessionId);
        clearSessionCookie(cookies, url);

        if (fcTargets.length > 0) {
            const redirectTo = await resolvePostLogoutRedirect(locals, postLogoutRedirectUri, clientId, state);
            const html = renderFrontchannelLogoutHtml(
                fcTargets.map((t) => t.uri),
                redirectTo,
            );
            return new Response(html, {
                status: 200,
                headers: { "Content-Type": "text/html; charset=utf-8" },
            });
        }

        const redirectTo = await resolvePostLogoutRedirect(locals, postLogoutRedirectUri, clientId, state);
        throw redirect(302, redirectTo);
    }

    const redirectTo = await resolvePostLogoutRedirect(locals, postLogoutRedirectUri, clientId, state);
    throw redirect(302, redirectTo);
};

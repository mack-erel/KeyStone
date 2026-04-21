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
    const iframes = iframeUris.map((u) => `<iframe src="${htmlEscape(u)}" style="display:none" sandbox="allow-same-origin allow-scripts"></iframe>`).join("");
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

async function resolvePostLogoutRedirect(locals: App.Locals, postLogoutRedirectUri: string | null, clientId: string | null): Promise<string> {
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
    if (Array.isArray(allowed) && allowed.includes(postLogoutRedirectUri)) return postLogoutRedirectUri;
    return "/";
}

export const GET: RequestHandler = async (event) => {
    const { locals, url, cookies, platform } = event;
    const postLogoutRedirectUri = url.searchParams.get("post_logout_redirect_uri");
    const clientId = url.searchParams.get("client_id");
    const idTokenHint = url.searchParams.get("id_token_hint");

    if (idTokenHint && locals.db && locals.tenant) {
        const claims = await verifyIdToken(locals.db, locals.tenant.id, idTokenHint);
        if (!claims) {
            return new Response(JSON.stringify({ error: "invalid_id_token_hint" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }
        if (locals.user && claims.sub !== locals.user.id) {
            return new Response(JSON.stringify({ error: "id_token_hint_mismatch" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }
    }

    // 세션이 있으면 BC/FC 로그아웃 타깃을 수집·발송한 뒤 세션을 폐기한다.
    // (세션 폐기 전에 sessionId / idpSessionId / userId 를 캡처해야 함.)
    if (locals.session && locals.user && locals.db && locals.tenant) {
        const db = locals.db;
        const tenantId = locals.tenant.id;
        const sessionId = locals.session.id;
        const idpSessionId = locals.session.idpSessionId;
        const userId = locals.user.id;

        const issuerUrl = locals.runtimeConfig.issuerUrl ?? url.origin;
        const signingKeySecret = locals.runtimeConfig.signingKeySecret;

        const bcTargets = await getOidcBackchannelTargets(db, tenantId, sessionId);
        const fcTargets = await getOidcFrontchannelTargets(db, tenantId, sessionId, idpSessionId, issuerUrl);

        // BC 로그아웃 발송 (서명 키가 있을 때만)
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

        // IdP 세션 폐기
        await revokeSession(db, idpSessionId);
        clearSessionCookie(cookies, url);

        // FC 타깃이 있으면 iframe 페이지를 렌더
        if (fcTargets.length > 0) {
            const redirectTo = await resolvePostLogoutRedirect(locals, postLogoutRedirectUri, clientId);
            const html = renderFrontchannelLogoutHtml(
                fcTargets.map((t) => t.uri),
                redirectTo,
            );
            return new Response(html, {
                status: 200,
                headers: { "Content-Type": "text/html; charset=utf-8" },
            });
        }

        // FC 가 없으면 바로 리다이렉트
        const redirectTo = await resolvePostLogoutRedirect(locals, postLogoutRedirectUri, clientId);
        throw redirect(302, redirectTo);
    }

    // 세션이 없는 경우: 기존 흐름
    const redirectTo = await resolvePostLogoutRedirect(locals, postLogoutRedirectUri, clientId);
    throw redirect(302, redirectTo);
};

export const POST: RequestHandler = (event) => GET(event);

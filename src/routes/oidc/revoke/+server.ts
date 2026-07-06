/**
 * OIDC / OAuth 2.0 Token Revocation 엔드포인트 (RFC 7009).
 *
 * POST /oidc/revoke
 *   body: token, [token_type_hint=refresh_token|access_token], client 인증
 *
 * refresh_token 은 DB 에서 폐기한다. access token 은 stateless HMAC(5분 TTL)이라
 * 서버 측 폐기 대상이 아니며, RFC 7009 §2.2 에 따라 어떤 경우든 200 을 반환한다.
 */

import type { RequestHandler } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { getRequestMetadata } from "$lib/server/audit";
import { checkRateLimit } from "$lib/server/ratelimit";
import { authenticateOidcClient } from "$lib/server/oidc/client";
import { revokeRefreshTokenByValue } from "$lib/server/oidc/refresh";
import { translate } from "$lib/i18n/server";

function errorResponse(code: string, description: string, status: number): Response {
    return new Response(JSON.stringify({ error: code, error_description: description }), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store, private", Pragma: "no-cache" },
    });
}

export const POST: RequestHandler = async (event) => {
    const { locals, request } = event;
    const { db, tenant } = requireDbContext(locals);

    const { ipKey } = getRequestMetadata(event);
    const rl = await checkRateLimit(db, `oidc-revoke:${ipKey}`, { windowMs: 60 * 1000, limit: 60 });
    if (!rl.allowed) {
        return new Response(JSON.stringify({ error: "rate_limit_exceeded", error_description: translate(locals.locale, "oidc.errors.rate_limited_short") }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
        });
    }

    const body = await request.formData();
    const auth = await authenticateOidcClient(db, tenant.id, request.headers.get("Authorization"), body);
    if (!auth.ok) return errorResponse(auth.code, auth.description, auth.status);

    const token = String(body.get("token") ?? "");
    // RFC 7009 §2.1: token 이 없으면 invalid_request. 그 외(무효/타 클라이언트 토큰)는 200.
    if (!token) return errorResponse("invalid_request", translate(locals.locale, "oidc.errors.token_param_required"), 400);

    const hint = String(body.get("token_type_hint") ?? "");
    // access_token 힌트가 명시된 경우 refresh 폐기를 건너뛴다(무의미한 조회 회피).
    // 그 외에는 refresh token 으로 간주해 폐기 시도한다. (access token 은 stateless 라 no-op)
    if (hint !== "access_token") {
        await revokeRefreshTokenByValue(db, tenant.id, auth.client.clientId, token);
    }

    // RFC 7009: 토큰 유효성과 무관하게 항상 200.
    return new Response(null, { status: 200, headers: { "Cache-Control": "no-store, private", Pragma: "no-cache" } });
};

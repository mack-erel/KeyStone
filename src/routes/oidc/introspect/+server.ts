/**
 * OAuth 2.0 Token Introspection 엔드포인트 (RFC 7662).
 *
 * POST /oidc/introspect
 *   body: token, [token_type_hint], client 인증
 *
 * 요청 클라이언트에게 발급된 토큰만 active 로 응답한다. 다른 클라이언트의 토큰이나
 * 무효/만료/폐기 토큰은 `{ active: false }` 로 응답한다 (RFC 7662 §2.2, 토큰 존재
 * 여부를 노출하지 않기 위해 항상 200).
 */

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { getRequestMetadata } from "$lib/server/audit";
import { checkRateLimit } from "$lib/server/ratelimit";
import { authenticateOidcClient } from "$lib/server/oidc/client";
import { findActiveRefreshToken } from "$lib/server/oidc/refresh";
import { verifyAccessToken, tryWithSecretsNullable } from "$lib/server/crypto/keys";
import { translate } from "$lib/i18n/server";

function errorResponse(code: string, description: string, status: number): Response {
    return new Response(JSON.stringify({ error: code, error_description: description }), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store, private", Pragma: "no-cache" },
    });
}

const INACTIVE = { active: false } as const;

function inactive(): Response {
    return json(INACTIVE, { headers: { "Cache-Control": "no-store, private", Pragma: "no-cache" } });
}

export const POST: RequestHandler = async (event) => {
    const { locals, request } = event;
    const { db, tenant, rateLimitStore } = requireDbContext(locals);
    const { signingKeySecrets } = locals.runtimeConfig;

    const { ipKey } = getRequestMetadata(event);
    const rl = await checkRateLimit(rateLimitStore, `oidc-introspect:${ipKey}`, { windowMs: 60 * 1000, limit: 60 });
    if (!rl.allowed) {
        return new Response(JSON.stringify({ error: "rate_limit_exceeded", error_description: translate(locals.locale, "oidc.errors.rate_limited_short") }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
        });
    }

    const body = await request.formData();
    const auth = await authenticateOidcClient(db, tenant.id, request.headers.get("Authorization"), body);
    if (!auth.ok) return errorResponse(auth.code, auth.description, auth.status);

    // ctrls R4: introspection(RFC 7662)은 자격 증명을 가진 confidential client 를 위한 보호
    // 엔드포인트다. secret 이 없는 public client(auth_method="none")는 인증 없이 통과하므로,
    // 토큰 메타데이터를 노출하지 않도록 항상 inactive 로 응답한다(존재 여부 oracle 차단).
    // revoke(RFC 7009)는 public client 도 자기 토큰을 폐기하도록 설계돼 그대로 둔다.
    if (auth.client.tokenEndpointAuthMethod === "none") return inactive();

    const token = String(body.get("token") ?? "");
    if (!token) return errorResponse("invalid_request", translate(locals.locale, "oidc.errors.token_param_required"), 400);

    const hint = String(body.get("token_type_hint") ?? "");
    const clientId = auth.client.clientId;

    // 1) access token 시도 (refresh_token 힌트가 명시된 경우는 건너뜀).
    if (hint !== "refresh_token" && signingKeySecrets.length > 0) {
        const claims = await tryWithSecretsNullable(signingKeySecrets, (s) => verifyAccessToken(token, s, tenant.id, clientId));
        if (claims) {
            return json(
                {
                    active: true,
                    scope: claims.scope,
                    client_id: clientId,
                    token_type: "Bearer",
                    sub: claims.sub,
                    aud: claims.aud,
                    iss: claims.iss,
                    exp: claims.exp,
                    iat: claims.iat,
                    jti: claims.jti,
                },
                { headers: { "Cache-Control": "no-store, private", Pragma: "no-cache" } },
            );
        }
    }

    // 2) refresh token 시도.
    if (hint !== "access_token") {
        const record = await findActiveRefreshToken(db, tenant.id, clientId, token);
        if (record) {
            return json(
                {
                    active: true,
                    scope: record.scope,
                    client_id: clientId,
                    token_type: "refresh_token",
                    sub: record.userId,
                    exp: Math.floor(record.expiresAt.getTime() / 1000),
                    iat: Math.floor(record.createdAt.getTime() / 1000),
                },
                { headers: { "Cache-Control": "no-store, private", Pragma: "no-cache" } },
            );
        }
    }

    return inactive();
};

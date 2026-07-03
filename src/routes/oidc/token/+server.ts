import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { oidcClients } from "$lib/server/db/schema";
import { requireDbContext } from "$lib/server/auth/guards";
import { findActiveUserById } from "$lib/server/auth/users";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit";
import { checkRateLimit } from "$lib/server/ratelimit";
import { findOidcClient, isValidClientSecret, parseBasicAuth } from "$lib/server/oidc/client";
import { findAndConsumeGrant } from "$lib/server/oidc/grant";
import { verifyPkce } from "$lib/server/oidc/pkce";
import { generateAccessToken, getActiveSigningKey, signJwt } from "$lib/server/crypto/keys";
import { getActiveAssignment, parseAssignmentAttributes } from "$lib/server/access/service-permissions";
import { resolveIssuerUrl } from "$lib/server/auth/runtime";

// ID Token 표준 클레임 — assignment.attributesJson 의 키와 충돌 시 표준 클레임이 우선한다.
const RESERVED_ID_TOKEN_CLAIMS = new Set(["iss", "sub", "aud", "azp", "iat", "exp", "auth_time", "jti", "nonce", "sid", "acr", "amr", "at_hash", "c_hash"]);

const ACCESS_TOKEN_TTL_S = 300; // 5분
const ID_TOKEN_TTL_S = 600; // 10분

function tokenError(code: string, description: string, status = 400): Response {
    return new Response(JSON.stringify({ error: code, error_description: description }), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store, private",
            Pragma: "no-cache",
        },
    });
}

export const POST: RequestHandler = async (event) => {
    const { locals, request, url } = event;
    const { db, tenant } = requireDbContext(locals);
    const { signingKeySecret } = locals.runtimeConfig;

    // 레이트 리밋: IP당 30회/분
    const { ip, ipKey, userAgent } = getRequestMetadata(event);
    const rl = await checkRateLimit(db, `token:${ipKey}`, { windowMs: 60 * 1000, limit: 30 });
    if (!rl.allowed) {
        return new Response(
            JSON.stringify({
                error: "rate_limit_exceeded",
                error_description: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
            }),
            {
                status: 429,
                headers: {
                    "Content-Type": "application/json",
                    "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
                },
            },
        );
    }

    if (!signingKeySecret) {
        return tokenError("server_error", "IDP_SIGNING_KEY_SECRET 가 설정되지 않았습니다.", 503);
    }

    const issuer = resolveIssuerUrl(locals.runtimeConfig, url.origin);
    const body = await request.formData();

    const recordTokenFailure = async (clientIdForAudit: string | null, errorCode: string, description: string): Promise<void> => {
        try {
            await recordAuditEvent(db, {
                tenantId: tenant.id,
                spOrClientId: clientIdForAudit,
                kind: "oidc_token",
                outcome: "failure",
                ip,
                userAgent,
                detail: { error: errorCode, description },
            });
        } catch {
            /* audit 기록 실패는 무시 */
        }
    };

    if (body.get("grant_type") !== "authorization_code") {
        await recordTokenFailure(null, "unsupported_grant_type", "authorization_code 외 grant_type");
        return tokenError("unsupported_grant_type", "authorization_code 만 지원합니다.");
    }

    // 클라이언트 인증 (Basic 헤더 또는 body params)
    let clientId: string;
    let clientSecret: string;

    const authHeader = request.headers.get("Authorization");
    if (authHeader) {
        const parsed = parseBasicAuth(authHeader);
        if (!parsed) {
            await recordTokenFailure(null, "invalid_client", "잘못된 Authorization 헤더");
            return tokenError("invalid_client", "잘못된 Authorization 헤더입니다.", 401);
        }
        clientId = parsed.clientId;
        clientSecret = parsed.clientSecret;
    } else {
        clientId = String(body.get("client_id") ?? "");
        clientSecret = String(body.get("client_secret") ?? "");
    }

    if (!clientId) {
        await recordTokenFailure(null, "invalid_client", "client_id 누락");
        return tokenError("invalid_client", "client_id 가 필요합니다.", 401);
    }

    const client = await findOidcClient(db, tenant.id, clientId);
    if (!client) {
        await recordTokenFailure(clientId, "invalid_client", "등록되지 않은 client_id");
        return tokenError("invalid_client", "등록되지 않은 클라이언트입니다.", 401);
    }

    const secretCheck = await isValidClientSecret(client, clientSecret, !!authHeader);
    if (!secretCheck.valid) {
        await recordTokenFailure(clientId, "invalid_client", "client_secret 검증 실패");
        return tokenError("invalid_client", "클라이언트 인증에 실패했습니다.", 401);
    }
    // 레거시 형식(argon2/pbkdf2) 해시는 검증 성공 시 sha256 으로 업그레이드 (best-effort)
    if (secretCheck.rehash) {
        try {
            await db.update(oidcClients).set({ clientSecretHash: secretCheck.rehash, updatedAt: new Date() }).where(eq(oidcClients.id, client.id));
        } catch (error) {
            // 실패해도 토큰 발급은 계속하되, 반복 실패(스키마/권한 문제)가 보이도록 로깅.
            // 업그레이드 전까지 이 클라이언트는 매 요청 레거시 KDF(느린 경로)를 탄다.
            console.error("client_secret 해시 업그레이드 실패", { clientId }, error);
        }
    }

    const code = String(body.get("code") ?? "");
    const redirectUri = String(body.get("redirect_uri") ?? "");
    const codeVerifier = String(body.get("code_verifier") ?? "");

    if (!code || !redirectUri) {
        await recordTokenFailure(clientId, "invalid_request", "code 또는 redirect_uri 누락");
        return tokenError("invalid_request", "code 와 redirect_uri 는 필수입니다.");
    }

    // 조회와 소진을 원자적으로 처리 (replay 방지)
    const grant = await findAndConsumeGrant(db, tenant.id, clientId, code);
    if (!grant) {
        await recordTokenFailure(clientId, "invalid_grant", "유효하지 않거나 만료된 code");
        return tokenError("invalid_grant", "유효하지 않거나 만료된 authorization code 입니다.");
    }

    if (grant.redirectUri !== redirectUri) {
        await recordTokenFailure(clientId, "invalid_grant", "redirect_uri mismatch");
        return tokenError("invalid_grant", "redirect_uri 가 일치하지 않습니다.");
    }

    // PKCE 검증
    if (grant.codeChallenge) {
        if (!codeVerifier) {
            await recordTokenFailure(clientId, "invalid_grant", "code_verifier 누락");
            return tokenError("invalid_grant", "code_verifier 가 필요합니다.");
        }
        const valid = await verifyPkce(grant.codeChallenge, grant.codeChallengeMethod ?? "plain", codeVerifier);
        if (!valid) {
            await recordTokenFailure(clientId, "invalid_grant", "code_verifier 검증 실패");
            return tokenError("invalid_grant", "code_verifier 검증에 실패했습니다.");
        }
    }

    // 서로 독립인 조회 3개를 병렬 실행 (Workers 요청당 PG 연결은 max 5 라 여유 있음).
    // 서비스 권한 매핑은 grant 발급 후 revoke 됐을 수 있으므로 token 시점에서 다시 조회한다.
    const [user, signingKey, assignment] = await Promise.all([
        findActiveUserById(db, grant.userId),
        getActiveSigningKey(db, tenant.id, signingKeySecret),
        getActiveAssignment(db, {
            tenantId: tenant.id,
            userId: grant.userId,
            serviceType: "oidc",
            serviceRefId: client.id,
        }),
    ]);

    if (!user) {
        await recordTokenFailure(clientId, "invalid_grant", "사용자 조회 실패");
        return tokenError("invalid_grant", "사용자를 찾을 수 없습니다.");
    }

    if (!signingKey) {
        return tokenError("server_error", "활성 서명 키를 찾을 수 없습니다.", 503);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const scopes = new Set(grant.scope.split(" "));

    // ID Token (RS256 JWT)
    const idTokenPayload: Record<string, unknown> = {
        iss: issuer,
        sub: user.id,
        aud: clientId,
        azp: clientId,
        iat: nowSec,
        exp: nowSec + ID_TOKEN_TTL_S,
        auth_time: Math.floor(grant.createdAt.getTime() / 1000),
        jti: crypto.randomUUID(),
    };

    // email scope
    if (scopes.has("email")) {
        idTokenPayload.email = user.email;
        idTokenPayload.email_verified = Boolean(user.emailVerifiedAt);
    }

    // profile scope
    if (scopes.has("profile")) {
        idTokenPayload.name = user.displayName;
        idTokenPayload.given_name = user.givenName;
        idTokenPayload.family_name = user.familyName;
        idTokenPayload.preferred_username = user.username ?? user.email.split("@")[0];
        idTokenPayload.picture = user.avatarUrl;
        idTokenPayload.locale = user.locale;
        idTokenPayload.zoneinfo = user.zoneinfo;
        idTokenPayload.birthdate = user.birthdate;
    }

    // phone scope
    if (scopes.has("phone")) {
        idTokenPayload.phone_number = user.phoneNumber;
        idTokenPayload.phone_number_verified = Boolean(user.phoneVerifiedAt);
    }

    if (grant.nonce) idTokenPayload.nonce = grant.nonce;
    if (grant.sessionId) idTokenPayload.sid = grant.sessionId;
    if (grant.acr) idTokenPayload.acr = grant.acr;

    // 서비스 권한 매핑 — role / 추가 attributes 를 ID Token 에 머지한다.
    if (assignment?.role) {
        idTokenPayload.roles = [assignment.role.key];
        idTokenPayload.roles_label = assignment.role.label;
    }
    if (assignment) {
        const extra = parseAssignmentAttributes(assignment.attributesJson);
        for (const [k, v] of Object.entries(extra)) {
            // 표준 클레임 우선 — 충돌 키는 무시
            if (RESERVED_ID_TOKEN_CLAIMS.has(k)) continue;
            idTokenPayload[k] = v;
        }
    }

    const idToken = await signJwt(idTokenPayload, signingKey.privateKey, signingKey.kid);

    // Opaque access token (HMAC-SHA256)
    const accessToken = await generateAccessToken(
        {
            sub: user.id,
            tenantId: tenant.id,
            clientId,
            scope: grant.scope,
            iat: nowSec,
            exp: nowSec + ACCESS_TOKEN_TTL_S,
            jti: crypto.randomUUID(),
            aud: clientId,
            iss: issuer,
        },
        signingKeySecret,
    );

    await recordAuditEvent(db, {
        tenantId: tenant.id,
        userId: user.id,
        actorId: user.id,
        spOrClientId: clientId,
        kind: "oidc_token",
        outcome: "success",
        ip,
        userAgent,
        detail: { clientId, scope: grant.scope },
    });

    return json(
        {
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: ACCESS_TOKEN_TTL_S,
            scope: grant.scope,
            id_token: idToken,
        },
        {
            headers: {
                "Cache-Control": "no-store, private",
                Pragma: "no-cache",
            },
        },
    );
};

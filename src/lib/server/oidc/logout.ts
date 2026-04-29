/**
 * OIDC Single Logout helpers (Front-channel 1.0 + Back-channel 1.0).
 *
 * Back-channel (BC):
 *   - IdP POSTs signed logout_token (JWT) to clients' `backchannel_logout_uri`.
 *   - Target set = clients with an active grant or refresh-token bound to this IdP session.
 *
 * Front-channel (FC):
 *   - IdP renders <iframe src=<frontchannel_logout_uri>?iss=...&sid=...> for each client.
 *   - Same target-set strategy as BC.
 */

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { DB } from "$lib/server/db";
import { oidcClients, oidcGrants, oidcRefreshTokens } from "$lib/server/db/schema";
import { signJwt } from "$lib/server/crypto/keys";

export interface BackchannelTarget {
    clientId: string;
    backchannelLogoutUri: string;
    backchannelLogoutSessionRequired: boolean;
}

export interface FrontchannelTarget {
    uri: string;
}

/**
 * 이 IdP 세션에 묶여 있는 활성 grant/refresh_token 이 있는 OIDC 클라이언트 중,
 * backchannel_logout_uri 가 설정된 클라이언트를 반환한다.
 */
export async function getOidcBackchannelTargets(db: DB, tenantId: string, sessionId: string): Promise<BackchannelTarget[]> {
    const grantClientIds = await db
        .select({ clientId: oidcGrants.clientId })
        .from(oidcGrants)
        .where(and(eq(oidcGrants.tenantId, tenantId), eq(oidcGrants.sessionId, sessionId)));
    const refreshClientIds = await db
        .select({ clientId: oidcRefreshTokens.clientId })
        .from(oidcRefreshTokens)
        .where(and(eq(oidcRefreshTokens.tenantId, tenantId), eq(oidcRefreshTokens.sessionId, sessionId), isNull(oidcRefreshTokens.revokedAt)));

    const clientIds = Array.from(new Set([...grantClientIds.map((r) => r.clientId), ...refreshClientIds.map((r) => r.clientId)]));
    if (clientIds.length === 0) return [];

    const rows = await db
        .select({
            clientId: oidcClients.clientId,
            backchannelLogoutUri: oidcClients.backchannelLogoutUri,
            backchannelLogoutSessionRequired: oidcClients.backchannelLogoutSessionRequired,
        })
        .from(oidcClients)
        .where(and(eq(oidcClients.tenantId, tenantId), inArray(oidcClients.clientId, clientIds), eq(oidcClients.enabled, true), isNotNull(oidcClients.backchannelLogoutUri)));

    const targets: BackchannelTarget[] = [];
    for (const row of rows) {
        if (!row.backchannelLogoutUri) continue;
        targets.push({
            clientId: row.clientId,
            backchannelLogoutUri: row.backchannelLogoutUri,
            backchannelLogoutSessionRequired: row.backchannelLogoutSessionRequired,
        });
    }
    return targets;
}

/**
 * 이 IdP 세션에 묶여 있는 활성 grant/refresh_token 이 있는 OIDC 클라이언트 중,
 * frontchannel_logout_uri 가 설정된 클라이언트의 iframe URL 목록을 반환한다.
 * frontchannelLogoutSessionRequired=true 인 클라이언트에만 sid 쿼리 파라미터를 추가한다.
 */
export async function getOidcFrontchannelTargets(db: DB, tenantId: string, sessionId: string, idpSessionId: string, issuerUrl: string): Promise<FrontchannelTarget[]> {
    const grantClientIds = await db
        .select({ clientId: oidcGrants.clientId })
        .from(oidcGrants)
        .where(and(eq(oidcGrants.tenantId, tenantId), eq(oidcGrants.sessionId, sessionId)));
    const refreshClientIds = await db
        .select({ clientId: oidcRefreshTokens.clientId })
        .from(oidcRefreshTokens)
        .where(and(eq(oidcRefreshTokens.tenantId, tenantId), eq(oidcRefreshTokens.sessionId, sessionId), isNull(oidcRefreshTokens.revokedAt)));

    const clientIds = Array.from(new Set([...grantClientIds.map((r) => r.clientId), ...refreshClientIds.map((r) => r.clientId)]));
    if (clientIds.length === 0) return [];

    const rows = await db
        .select({
            frontchannelLogoutUri: oidcClients.frontchannelLogoutUri,
            frontchannelLogoutSessionRequired: oidcClients.frontchannelLogoutSessionRequired,
        })
        .from(oidcClients)
        .where(and(eq(oidcClients.tenantId, tenantId), inArray(oidcClients.clientId, clientIds), eq(oidcClients.enabled, true), isNotNull(oidcClients.frontchannelLogoutUri)));

    const targets: FrontchannelTarget[] = [];
    for (const row of rows) {
        if (!row.frontchannelLogoutUri) continue;
        const base = row.frontchannelLogoutUri;
        const sep = base.includes("?") ? "&" : "?";
        let uri = `${base}${sep}iss=${encodeURIComponent(issuerUrl)}`;
        if (row.frontchannelLogoutSessionRequired) {
            uri += `&sid=${encodeURIComponent(idpSessionId)}`;
        }
        targets.push({ uri });
    }
    return targets;
}

/**
 * 단일 OIDC BC 타깃에 logout_token 을 POST 한다.
 * 네트워크 오류는 호출자에서 swallow 하도록 래핑하고, 여기서는 정상 경로에 대한
 * 검증만 수행한다 (비정상 상태 코드도 RP 측 문제이므로 IdP 는 재시도하지 않는다).
 */
export async function sendOneBackchannelLogout(target: BackchannelTarget, userId: string, idpSessionId: string, issuerUrl: string, privateKey: CryptoKey, kid: string): Promise<void> {
    const payload: Record<string, unknown> = {
        iss: issuerUrl,
        sub: userId,
        aud: target.clientId,
        iat: Math.floor(Date.now() / 1000),
        jti: crypto.randomUUID(),
        events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    };
    if (target.backchannelLogoutSessionRequired) {
        payload.sid = idpSessionId;
    }

    // BC logout JWT 는 일반 ID Token 과 구별되어야 하므로 typ=logout+jwt (RFC: OpenID BC logout 1.0)
    const jwt = await signJwt(payload, privateKey, kid, { typ: "logout+jwt" });
    const body = new URLSearchParams({ logout_token: jwt });

    await fetch(target.backchannelLogoutUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });
}

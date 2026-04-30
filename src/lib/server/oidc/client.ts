import { and, eq } from "drizzle-orm";
import type { DB } from "$lib/server/db";
import { oidcClients } from "$lib/server/db/schema";
import { verifyPassword } from "$lib/server/auth/password";

export type OidcClientRecord = typeof oidcClients.$inferSelect;

export async function findOidcClient(db: DB, tenantId: string, clientId: string): Promise<OidcClientRecord | null> {
    const [client] = await db
        .select()
        .from(oidcClients)
        .where(and(eq(oidcClients.tenantId, tenantId), eq(oidcClients.clientId, clientId), eq(oidcClients.enabled, true)))
        .limit(1);
    return client ?? null;
}

export function parseBasicAuth(authHeader: string): { clientId: string; clientSecret: string } | null {
    if (!authHeader.startsWith("Basic ")) return null;
    const decoded = atob(authHeader.slice(6));
    const sep = decoded.indexOf(":");
    try {
        return {
            clientId: decodeURIComponent(sep > -1 ? decoded.slice(0, sep) : decoded),
            clientSecret: decodeURIComponent(sep > -1 ? decoded.slice(sep + 1) : ""),
        };
    } catch {
        return null;
    }
}

export async function isValidClientSecret(client: OidcClientRecord, clientSecret: string): Promise<boolean> {
    if (client.tokenEndpointAuthMethod === "none") return true;
    if (!client.clientSecretHash || !clientSecret) return false;
    const result = await verifyPassword(clientSecret, client.clientSecretHash);
    return result.valid;
}

export function parseRedirectUris(client: OidcClientRecord): string[] {
    try {
        return JSON.parse(client.redirectUris ?? "[]") as string[];
    } catch {
        return [];
    }
}

/**
 * redirect_uri 매칭. 정확 일치 + 제한된 와일드카드 패턴 지원.
 *
 * 와일드카드 규칙 (보안 우선):
 * - `*` 는 host 의 **가장 좌측(leftmost) 라벨 안에서만** 허용
 * - `*` 한 개만 허용
 * - `*` 는 점(.) 을 포함하지 않는 한 라벨에 매칭 (subdomain hijack 방지)
 * - scheme / port / path / query / fragment / 그 외 라벨은 정확히 일치해야 함
 *
 * 예시:
 *   pattern  https://pr*.ctrls.kr/auth/callback
 *   ✓       https://pr1.ctrls.kr/auth/callback
 *   ✓       https://pr42.ctrls.kr/auth/callback
 *   ✗       https://evil.pr1.ctrls.kr/auth/callback   (라벨 수 다름)
 *   ✗       https://pr1.evil.kr/auth/callback         (오른쪽 라벨 다름)
 *   ✗       https://pr1.ctrls.kr/auth/x               (path 다름)
 *   ✗       http://pr1.ctrls.kr/auth/callback         (scheme 다름)
 */
export function matchesRedirectUri(pattern: string, candidate: string): boolean {
    if (pattern === candidate) return true;
    if (!pattern.includes("*")) return false;

    const split = (uri: string) => {
        const m = uri.match(/^([^:]+:\/\/)([^/]+)(.*)$/);
        if (!m) return null;
        return { protocol: m[1], host: m[2], rest: m[3] };
    };
    const p = split(pattern);
    const c = split(candidate);
    if (!p || !c) return false;

    // scheme + port + path + query + fragment 정확 일치
    if (p.protocol !== c.protocol) return false;
    if (p.rest !== c.rest) return false;

    // host 라벨 단위 비교
    const pLabels = p.host.split(".");
    const cLabels = c.host.split(".");
    if (pLabels.length !== cLabels.length) return false;

    // 와일드카드는 정확히 한 개, leftmost 라벨에만
    const stars = (p.host.match(/\*/g) ?? []).length;
    if (stars !== 1) return false;
    if (!pLabels[0].includes("*")) return false;
    for (let i = 1; i < pLabels.length; i++) {
        if (pLabels[i].includes("*")) return false;
    }

    // leftmost 라벨: 정규식으로 매칭, * → [^.]+
    const escaped = pLabels[0].replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
    const regex = new RegExp("^" + escaped.replace(/\*/g, "[^.]+") + "$");
    if (!regex.test(cLabels[0])) return false;

    // 그 외 라벨은 정확 일치
    for (let i = 1; i < pLabels.length; i++) {
        if (pLabels[i] !== cLabels[i]) return false;
    }
    return true;
}

export function isAllowedRedirectUri(client: OidcClientRecord, redirectUri: string): boolean {
    return parseRedirectUris(client).some((pattern) => matchesRedirectUri(pattern, redirectUri));
}

export function parseGrantedScopes(client: OidcClientRecord, requestedScope: string): string[] {
    // RFC 6749: scope 토큰은 SP(공백) 으로만 구분된다. 콤마 등은 허용하지 않는다.
    const allowedScopes = client.scopes
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
    return requestedScope
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && allowedScopes.includes(s));
}

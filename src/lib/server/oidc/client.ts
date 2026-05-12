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

// ctrls H-OIDC-3: parseBasicAuth 안정화.
// - atob() 가 invalid base64 에서 throw → try/catch 로 감싸 500 DoS 방지.
// - 입력 길이 가드 — 비정상적으로 큰 Authorization 헤더 즉시 거부.
// - sep === -1 (콜론 없음) 인 입력은 RFC 7617 위반이므로 거부 (이전엔 빈 secret 통과).
const MAX_BASIC_AUTH_BYTES = 4096;
export function parseBasicAuth(authHeader: string): { clientId: string; clientSecret: string } | null {
    if (!authHeader.startsWith("Basic ")) return null;
    const raw = authHeader.slice(6).trim();
    if (raw.length === 0 || raw.length > MAX_BASIC_AUTH_BYTES) return null;
    try {
        const decoded = atob(raw);
        const sep = decoded.indexOf(":");
        if (sep === -1) return null;
        return {
            clientId: decodeURIComponent(decoded.slice(0, sep)),
            clientSecret: decodeURIComponent(decoded.slice(sep + 1)),
        };
    } catch {
        return null;
    }
}

// ctrls H-OIDC-3: public client (auth_method = "none") 의 Basic auth 거부.
// 기존엔 method === "none" 이면 secret 무관 true 반환 → public client 가 Basic 헤더로
// 빈 secret 보내도 통과. RFC 6749 §2.3.1: public client 는 인증 정보를 보내선 안 됨.
// 호출부에서 `hasAuthHeader` 를 넘기지 않으면 (기존 호출 호환) 기존 동작 유지하되,
// public client 의 secret 은 "" 인 경우만 통과시키도록 강화.
export async function isValidClientSecret(client: OidcClientRecord, clientSecret: string, hasAuthHeader: boolean = false): Promise<boolean> {
    if (client.tokenEndpointAuthMethod === "none") {
        return !hasAuthHeader && clientSecret === "";
    }
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
// ctrls H-OIDC-4: 와일드카드 매칭은 client 가 명시적으로 허용한 경우에만.
// 기본 false — admin 이 wildcard 패턴을 등록해 두었어도 plumbing 단에서 거부된다.
// subdomain takeover (dangling CNAME, 만료된 cloud subdomain 등) 사고면적 제거.
export function matchesRedirectUri(pattern: string, candidate: string, allowWildcard: boolean = false): boolean {
    if (pattern === candidate) return true;
    if (!pattern.includes("*")) return false;
    if (!allowWildcard) return false;

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
    // ctrls H-OIDC-4: client.allowWildcardRedirectUri 가 true 일 때만 와일드카드 매칭 활성.
    const allowWildcard = Boolean(client.allowWildcardRedirectUri);
    return parseRedirectUris(client).some((pattern) => matchesRedirectUri(pattern, redirectUri, allowWildcard));
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

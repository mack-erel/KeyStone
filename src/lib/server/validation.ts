/**
 * admin 라우트 공통 검증 유틸.
 * 여러 라우트(oidc-clients/saml-sps/skins/ldap-providers)에 흩어져 중복되던
 * 공통 판정을 한곳으로 모은다.
 */

/**
 * 검증 실패 사유. 로케일 비의존 — i18n 키(admin.errors.<key>)와 치환 파라미터만 담는다.
 * 호출부에서 `adminError(locale, reason.key, reason.params)` 로 표시 문자열을 만든다.
 */
export type ValidationReason = { key: string; params?: Record<string, string | number> };

/** URL/host 검증 결과 공통 형태. */
export type ValidationResult = { ok: true } | { ok: false; reason: ValidationReason };

/**
 * loopback 호스트 판정. http URL 허용(개발/내부) 여부나 SSRF 게이트에서 공통 사용.
 * 대괄호 IPv6 표기([::1])도 포함한다.
 */
export function isLoopbackHost(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** 명백한 SSRF 표적인 클라우드 메타데이터 호스트 집합. */
const BLOCKED_METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.azure.com", "metadata.azure.internal", "instance-data", "metadata"]);

/** 클라우드 메타데이터 호스트(GCP/Azure 등) 판정. SSRF 게이트에서 사용. */
export function isCloudMetadataHost(hostname: string): boolean {
    return BLOCKED_METADATA_HOSTS.has(hostname.toLowerCase());
}

/** link-local(169.254.0.0/16, AWS IMDS 169.254.169.254 포함) 판정. */
export function isLinkLocalHost(hostname: string): boolean {
    return /^169\.254\./.test(hostname.toLowerCase());
}

/**
 * ctrls M-1(SSRF): 서버측(IdP egress)에서 fetch 하는 아웃바운드 웹훅 URI 의 호스트가
 * SSRF 표적인지 검사한다. redirect_uri 같은 "브라우저가 향하는" URL 과 달리,
 * backchannel/frontchannel logout·role-change URI 는 Worker 가 직접 서버측 POST 하므로
 * loopback/사설망/메타데이터 호스트는 정상 사용처가 없다 — 전부 차단(LDAP 게이트보다 강함).
 *
 * 주의: 호스트명이 사설 IP 로 resolve 되는 DNS-rebinding 은 리터럴 차단만으로는 막지
 * 못한다(fetch 시점 재검증으로 완화하되, 완전 차단하려면 resolve 후 IP 검사 필요).
 */
export function isForbiddenWebhookHost(hostname: string): boolean {
    const h = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (isCloudMetadataHost(h) || isLinkLocalHost(h) || isLoopbackHost(hostname)) return true;
    // IPv4 사설/특수 대역
    if (/^127\./.test(h)) return true; // loopback /8
    if (/^10\./.test(h)) return true; // 10/8
    if (/^192\.168\./.test(h)) return true; // 192.168/16
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true; // 172.16/12
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true; // 100.64/10 CGNAT
    if (/^0\./.test(h) || h === "0.0.0.0") return true; // "this host"
    // IPv6 특수 대역
    if (h === "::" || h === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 unique-local
    if (/^fe80:/.test(h)) return true; // link-local
    return false;
}

/**
 * 아웃바운드 웹훅 URL 검증. https 강제 + SSRF 호스트 차단.
 * @param label 에러 메시지 접두사(예: "Role-change URI").
 */
export function validateWebhookUrl(value: string, label: string): ValidationResult {
    if (!value) return { ok: true };
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return { ok: false, reason: { key: "saml_url_invalid_format", params: { label } } };
    }
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    if (scheme !== "https") {
        return { ok: false, reason: { key: "webhook_url_https_only", params: { label } } };
    }
    if (isForbiddenWebhookHost(parsed.hostname)) {
        return { ok: false, reason: { key: "webhook_url_ssrf_host_forbidden", params: { label } } };
    }
    return { ok: true };
}

/**
 * SAML ACS/SLO 등 SP URL 검증. 빈 값은 통과(선택 필드).
 * https 만 허용하되, http 는 loopback 호스트에 한해 허용(개발/내부).
 * @param label 에러 메시지 접두사(예: "ACS URL").
 */
export function validateSamlUrl(value: string, label: string): ValidationResult {
    if (!value) return { ok: true };
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return { ok: false, reason: { key: "saml_url_invalid_format", params: { label } } };
    }
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    if (scheme === "https") return { ok: true };
    if (scheme === "http") {
        if (isLoopbackHost(parsed.hostname)) return { ok: true };
        return { ok: false, reason: { key: "saml_url_http_loopback_only", params: { label } } };
    }
    return { ok: false, reason: { key: "saml_url_https_only", params: { label } } };
}

/**
 * LDAP 호스트가 메타데이터 / link-local 등 명백한 SSRF 표적인지 검사.
 * RFC1918 사설망은 사내 LDAP 정상 사용처가 많아 차단하지 않는다.
 */
export function validateLdapHost(host: string): ValidationResult {
    const lower = host.toLowerCase();
    if (isCloudMetadataHost(lower)) {
        return { ok: false, reason: { key: "ldap_metadata_host_forbidden" } };
    }
    // 169.254.0.0/16 link-local (AWS IMDS 169.254.169.254 포함)
    if (isLinkLocalHost(lower)) {
        return { ok: false, reason: { key: "ldap_linklocal_forbidden" } };
    }
    return { ok: true };
}

/** 허용 LDAP 포트: 389(ldap), 636(ldaps), 3268/3269(GC). */
const ALLOWED_LDAP_PORTS = new Set([389, 636, 3268, 3269]);

/** LDAP 포트 검증(정수 범위 + 허용 목록). */
export function validateLdapPort(port: number): ValidationResult {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, reason: { key: "ldap_port_invalid" } };
    }
    if (!ALLOWED_LDAP_PORTS.has(port)) {
        return { ok: false, reason: { key: "ldap_port_not_allowed", params: { allowed: [...ALLOWED_LDAP_PORTS].join(", ") } } };
    }
    return { ok: true };
}

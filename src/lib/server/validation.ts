/**
 * admin 라우트 공통 검증 유틸.
 * 여러 라우트(oidc-clients/saml-sps/skins/ldap-providers)에 흩어져 중복되던
 * 공통 판정을 한곳으로 모은다.
 */

/**
 * loopback 호스트 판정. http URL 허용(개발/내부) 여부나 SSRF 게이트에서 공통 사용.
 * 대괄호 IPv6 표기([::1])도 포함한다.
 */
export function isLoopbackHost(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

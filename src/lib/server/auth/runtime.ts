export interface RuntimeConfig {
    defaultTenantName: string;
    issuerUrl?: string;
    signingKeySecret?: string;
}

type EnvLookup = Record<string, unknown>;

function getString(env: EnvLookup | undefined, key: string): string | undefined {
    const value = env?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getRuntimeConfig(platform: App.Platform | undefined): RuntimeConfig {
    const env = platform?.env as EnvLookup | undefined;

    return {
        defaultTenantName: getString(env, "IDP_DEFAULT_TENANT_NAME") ?? "Default Tenant",
        issuerUrl: getString(env, "IDP_ISSUER_URL")?.trim().replace(/\/$/, ""),
        signingKeySecret: getString(env, "IDP_SIGNING_KEY_SECRET"),
    };
}

/**
 * ctrls C-10 후속 sweep: issuer URL 결정 헬퍼.
 *
 * IDP_ISSUER_URL 환경변수가 설정되어 있으면 그 값을 사용. 미설정 시 들어온
 * 요청의 origin 으로 fallback (dev 환경 호환). production 에서 이 fallback 이
 * 동작하면 Host 헤더 주입으로 iss 클레임이 오염될 수 있어 운영 가시화를 위해
 * console.warn 한 번 남긴다 (cold start 마다 1회).
 *
 * 본 sweep 의 호스트 주입 영향:
 * - discovery/token/userinfo: 발급 토큰의 iss 가 attacker 도메인 — RP 가
 *   strict iss 검증하면 거부 (대부분의 RP) → self-DoS. RP 가 느슨하면
 *   attacker 도메인 신뢰로 이어질 수 있음.
 * - end-session expectedIssuer: legitimate id_token_hint 의 iss 불일치 →
 *   verifyIdToken 실패 → self-DoS.
 * - SAML SLO/logout: SAML 메시지의 Issuer 가 attacker 도메인 — 마찬가지로
 *   SP 의 strict 검증으로 거부 → self-DoS.
 *
 * 직접 RCE/탈취는 아니지만 RP 호환성 + 운영 위생 차원에서 정상 발급은
 * issuerUrl 가 명시된 경우에만 발생하도록 한다.
 */
let warnedMissingIssuer = false;
export function resolveIssuerUrl(runtimeConfig: RuntimeConfig | undefined, fallbackOrigin: string): string {
    if (runtimeConfig?.issuerUrl) return runtimeConfig.issuerUrl;
    if (!warnedMissingIssuer) {
        warnedMissingIssuer = true;
        console.warn("[runtime] IDP_ISSUER_URL 미설정 — 요청 Host 기반 origin fallback. 운영에서는 반드시 명시할 것.");
    }
    return fallbackOrigin.replace(/\/+$/, "");
}

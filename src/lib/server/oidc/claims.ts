/**
 * OIDC 표준 클레임 구성 헬퍼.
 * token(id_token) 과 userinfo 응답이 동일 로직을 공유하도록 이곳에 모은다.
 */

import type { UserMembership } from "$lib/server/org/membership";

/** `organization` scope 로 노출되는 조직 클레임 묶음. id_token / userinfo 동일. */
export interface OrganizationClaims {
    department: Array<{
        id: string;
        name: string;
        code: string | null;
        is_primary: boolean;
        job_title: string | null;
        position: { id: string; name: string; code: string | null; level: number } | null;
    }>;
    team: Array<{
        id: string;
        name: string;
        code: string | null;
        department: string | null;
        is_primary: boolean;
        job_title: string | null;
    }>;
    position: string | null;
    job_title: string | null;
}

/**
 * 클라이언트별 `organization` 클레임 노출 토글. 각 필드가 `false` 면 해당 최상위 클레임
 * 키를 응답에서 생략한다. 저장은 oidcClients.organizationClaimConfig(JSON text)에 한다.
 * **null/미설정이면 전량 노출**(하위호환) — parseOrganizationClaimConfig 가 null 을 반환한다.
 */
export interface OrganizationClaimConfig {
    department?: boolean;
    team?: boolean;
    position?: boolean;
    jobTitle?: boolean;
}

/** organization 클레임 노출 토글의 UI/저장 키 목록(단일 출처). */
export const ORGANIZATION_CLAIM_FIELDS = ["department", "team", "position", "jobTitle"] as const;

/**
 * oidcClients.organizationClaimConfig(JSON text) 를 파싱한다. 파싱 실패·null·미설정이면
 * null 을 반환해 **전량 노출(하위호환)** 로 폴백한다. 알려진 boolean 필드만 취해 오염을 막는다.
 */
export function parseOrganizationClaimConfig(raw: string | null | undefined): OrganizationClaimConfig | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed == null || typeof parsed !== "object") return null;
        const config: OrganizationClaimConfig = {};
        for (const field of ORGANIZATION_CLAIM_FIELDS) {
            if (typeof parsed[field] === "boolean") config[field] = parsed[field] as boolean;
        }
        return config;
    } catch {
        return null;
    }
}

/**
 * `organization` scope 조직 클레임(department/team/position/job_title)을 구성한다.
 * token 엔드포인트의 id_token 과 userinfo 응답이 **동일 로직**을 공유하도록 공용화한다
 * (과거 token 은 이 매핑이 없어 organization scope 만 요청 시 id_token 에 조직정보가 누락됐다).
 *
 * `config` 로 클라이언트별 필드 노출을 제어한다:
 *   - config == null → 네 필드 모두 노출(**하위호환** — 기존 클라이언트는 config 가 없다).
 *   - config.<field> === false → 해당 최상위 클레임 키를 생략.
 *   - config.<field> 가 undefined/true → 노출(누락 필드는 안전하게 노출로 취급).
 * token 과 userinfo 가 **동일 config** 를 적용해야 id_token=userinfo 정합이 유지된다.
 */
export function buildOrganizationClaims(membership: UserMembership, config?: OrganizationClaimConfig | null): Partial<OrganizationClaims> {
    const show = (field: keyof OrganizationClaimConfig): boolean => config == null || config[field] !== false;

    const claims: Partial<OrganizationClaims> = {};
    if (show("department")) {
        claims.department = membership.departments.map((d) => ({
            id: d.id,
            name: d.name,
            code: d.code,
            is_primary: d.isPrimary,
            job_title: d.jobTitle,
            position: d.position
                ? {
                      id: d.position.id,
                      name: d.position.name,
                      code: d.position.code,
                      level: d.position.level,
                  }
                : null,
        }));
    }
    if (show("team")) {
        claims.team = membership.teams.map((t) => ({
            id: t.id,
            name: t.name,
            code: t.code,
            department: t.departmentName,
            is_primary: t.isPrimary,
            job_title: t.jobTitle,
        }));
    }
    if (show("position")) {
        claims.position = membership.primaryPosition?.name ?? null;
    }
    if (show("jobTitle")) {
        claims.job_title = membership.primaryJobTitle ?? null;
    }
    return claims;
}

/** users 테이블의 주소 컬럼 부분집합. */
export interface AddressClaimSource {
    addressStreet: string | null;
    addressLocality: string | null;
    addressRegion: string | null;
    addressPostalCode: string | null;
    addressCountry: string | null;
}

/**
 * OIDC 표준 `address` 클레임(JSON object)을 구성한다.
 * https://openid.net/specs/openid-connect-core-1_0.html#AddressClaim
 *
 * - street_address / locality / region / postal_code / country 는 각 컬럼을 그대로 매핑한다.
 * - formatted 는 저장하지 않고 존재하는 구성요소만 조합한다(빈 값 제외).
 * - 모든 하위 필드가 비어 있으면 null 을 반환한다(빈 object 발급 금지).
 */
export function buildAddressClaim(source: AddressClaimSource): Record<string, string> | null {
    const street = source.addressStreet?.trim() || null;
    const locality = source.addressLocality?.trim() || null;
    const region = source.addressRegion?.trim() || null;
    const postalCode = source.addressPostalCode?.trim() || null;
    const country = source.addressCountry?.trim() || null;

    if (!street && !locality && !region && !postalCode && !country) return null;

    const claim: Record<string, string> = {};
    if (street) claim.street_address = street;
    if (locality) claim.locality = locality;
    if (region) claim.region = region;
    if (postalCode) claim.postal_code = postalCode;
    if (country) claim.country = country;

    // formatted: street_address 는 별도 줄, locality/region/postal_code 는 한 줄로, country 는 마지막 줄.
    const cityLine = [locality, region, postalCode].filter(Boolean).join(" ");
    const lines = [street, cityLine || null, country].filter((v): v is string => Boolean(v));
    if (lines.length > 0) claim.formatted = lines.join("\n");

    return claim;
}

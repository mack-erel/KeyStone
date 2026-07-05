/**
 * OIDC 표준 클레임 구성 헬퍼.
 * token(id_token) 과 userinfo 응답이 동일 로직을 공유하도록 이곳에 모은다.
 */

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

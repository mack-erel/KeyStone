import { describe, it, expect } from "vitest";
import { parseGrantedScopes, isAllowedRedirectUri, type OidcClientRecord } from "$lib/server/oidc/client";

function client(partial: Partial<OidcClientRecord>): OidcClientRecord {
    return partial as unknown as OidcClientRecord;
}

describe("parseGrantedScopes", () => {
    it("클라이언트 허용 scope 로 교집합만 반환", () => {
        const c = client({ scopes: "openid profile email" });
        expect(parseGrantedScopes(c, "openid profile phone")).toEqual(["openid", "profile"]);
    });

    it("허용되지 않은 scope 는 제거", () => {
        const c = client({ scopes: "openid" });
        expect(parseGrantedScopes(c, "openid admin superuser")).toEqual(["openid"]);
    });

    it("공백 다중/앞뒤 공백 정규화", () => {
        const c = client({ scopes: "openid  email" });
        expect(parseGrantedScopes(c, "  openid   email  ")).toEqual(["openid", "email"]);
    });

    it("offline_access 도 클라이언트가 허용하면 통과", () => {
        const c = client({ scopes: "openid offline_access" });
        expect(parseGrantedScopes(c, "openid offline_access")).toEqual(["openid", "offline_access"]);
    });
});

describe("isAllowedRedirectUri", () => {
    it("정확히 등록된 URI 만 허용", () => {
        const c = client({ redirectUris: JSON.stringify(["https://app.example.com/callback"]), allowWildcardRedirectUri: false });
        expect(isAllowedRedirectUri(c, "https://app.example.com/callback")).toBe(true);
        expect(isAllowedRedirectUri(c, "https://app.example.com/other")).toBe(false);
        expect(isAllowedRedirectUri(c, "https://evil.example.com/callback")).toBe(false);
    });

    it("와일드카드는 opt-in(allowWildcardRedirectUri) 없이는 리터럴로만 매칭", () => {
        const c = client({ redirectUris: JSON.stringify(["https://*.example.com/cb"]), allowWildcardRedirectUri: false });
        // opt-in 아니면 와일드카드 패턴이 실제 서브도메인에 매칭되지 않아야 한다.
        expect(isAllowedRedirectUri(c, "https://app.example.com/cb")).toBe(false);
    });
});

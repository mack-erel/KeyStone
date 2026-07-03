import { describe, it, expect } from "vitest";
import { verifyPkce } from "$lib/server/oidc/pkce";

// RFC 7636 Appendix B 테스트 벡터.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE_S256 = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("verifyPkce", () => {
    it("S256: RFC 7636 벡터 검증 성공", async () => {
        expect(await verifyPkce(RFC_CHALLENGE_S256, "S256", RFC_VERIFIER)).toBe(true);
    });

    it("S256: 잘못된 verifier 거부", async () => {
        expect(await verifyPkce(RFC_CHALLENGE_S256, "S256", "wrong-verifier")).toBe(false);
    });

    it("plain 방식은 보안상 항상 거부 (code_verifier 노출 방지)", async () => {
        // plain 은 challenge==verifier 여도 거부되어야 한다 (S256 전용 정책).
        expect(await verifyPkce("abc123", "plain", "abc123")).toBe(false);
        expect(await verifyPkce("abc123", "unknown-method", "abc123")).toBe(false);
    });
});

import { describe, it, expect } from "vitest";
import { base32Encode, base32Decode, generateTotpCode, verifyTotp, generateTotpSecret } from "$lib/server/auth/totp";

describe("base32", () => {
    it("인코딩→디코딩 라운드트립", () => {
        const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        const decoded = base32Decode(base32Encode(bytes));
        expect(Array.from(decoded)).toEqual(Array.from(bytes));
    });

    it("빈 입력", () => {
        expect(base32Encode(new Uint8Array([]))).toBe("");
    });
});

describe("TOTP", () => {
    it("같은 secret+step 은 같은 코드 (결정론적)", async () => {
        const secret = generateTotpSecret();
        const a = await generateTotpCode(secret, 0);
        const b = await generateTotpCode(secret, 0);
        expect(a).toBe(b);
        expect(a).toMatch(/^\d{6}$/);
    });

    it("현재 코드는 검증 통과", async () => {
        const secret = generateTotpSecret();
        const code = await generateTotpCode(secret);
        const step = await verifyTotp(code, secret);
        expect(step).not.toBeNull();
    });

    it("ctrls C3: lastUsedStep 로 재사용 거부", async () => {
        const secret = generateTotpSecret();
        const code = await generateTotpCode(secret);
        const step = await verifyTotp(code, secret);
        expect(step).not.toBeNull();
        // 방금 사용한 스텝을 lastUsedStep 으로 넘기면 같은 코드가 거부되어야 한다.
        const reused = await verifyTotp(code, secret, step!);
        expect(reused).toBeNull();
    });

    it("잘못된 코드 거부", async () => {
        const secret = generateTotpSecret();
        expect(await verifyTotp("000000", secret)).toBeNull();
    });
});

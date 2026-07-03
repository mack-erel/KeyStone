import { describe, it, expect } from "vitest";
import { normalizeIpForRateLimit } from "$lib/server/audit/index";

describe("normalizeIpForRateLimit (C6)", () => {
    it("null/빈 값은 unknown", () => {
        expect(normalizeIpForRateLimit(null)).toBe("unknown");
        expect(normalizeIpForRateLimit(undefined)).toBe("unknown");
        expect(normalizeIpForRateLimit("")).toBe("unknown");
        expect(normalizeIpForRateLimit("   ")).toBe("unknown");
    });

    it("IPv4 는 그대로 통과", () => {
        expect(normalizeIpForRateLimit("203.0.113.7")).toBe("203.0.113.7");
        expect(normalizeIpForRateLimit("10.0.0.1")).toBe("10.0.0.1");
    });

    it("IPv6 는 /64 프리픽스로 정규화 (앞 4 hextet)", () => {
        expect(normalizeIpForRateLimit("2001:db8:1234:5678:9abc:def0:1111:2222")).toBe("2001:db8:1234:5678::/64");
    });

    it("같은 /64 안의 서로 다른 /128 은 같은 키로 묶인다 (우회 방지)", () => {
        const a = normalizeIpForRateLimit("2001:db8:1234:5678:aaaa:aaaa:aaaa:aaaa");
        const b = normalizeIpForRateLimit("2001:db8:1234:5678:ffff:ffff:ffff:ffff");
        expect(a).toBe(b);
        expect(a).toBe("2001:db8:1234:5678::/64");
    });

    it("압축(::) IPv6 를 확장해 처리", () => {
        // 2001:db8::1 → 그룹 [2001, db8, 0, 0, 0, 0, 0, 1] → 앞 4 = 2001:db8:0:0
        expect(normalizeIpForRateLimit("2001:db8::1")).toBe("2001:db8:0:0::/64");
    });

    it("대문자 hextet 은 소문자로 정규화", () => {
        expect(normalizeIpForRateLimit("2001:DB8:ABCD:1234:5:6:7:8")).toBe("2001:db8:abcd:1234::/64");
    });

    it("zone id / 대괄호 제거", () => {
        expect(normalizeIpForRateLimit("[2001:db8:1:2:3:4:5:6]")).toBe("2001:db8:1:2::/64");
        expect(normalizeIpForRateLimit("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    });
});

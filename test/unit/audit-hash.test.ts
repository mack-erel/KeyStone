import { describe, it, expect } from "vitest";
import { computeAuditHash } from "$lib/server/audit/index";

const baseRow = {
    id: "11111111-1111-1111-1111-111111111111",
    tenantId: "t1",
    userId: "u1",
    actorId: "u1",
    spOrClientId: null,
    kind: "login",
    outcome: "success",
    ip: "203.0.113.1",
    userAgent: "test",
    detailJson: null,
    createdAtMs: 1_783_000_000_000,
};

describe("computeAuditHash (H-ADMIN-2)", () => {
    it("결정론적: 같은 입력·키는 같은 hash", async () => {
        const a = await computeAuditHash("secret-key", baseRow);
        const b = await computeAuditHash("secret-key", baseRow);
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/); // HMAC-SHA256 hex
    });

    it("필드 변조 시 hash 변경 (tamper-evident)", async () => {
        const original = await computeAuditHash("secret-key", baseRow);
        const tampered = await computeAuditHash("secret-key", { ...baseRow, outcome: "failure" });
        expect(tampered).not.toBe(original);
    });

    it("키가 다르면 hash 다름 (키 없이는 위조 불가)", async () => {
        const withKey1 = await computeAuditHash("key-1", baseRow);
        const withKey2 = await computeAuditHash("key-2", baseRow);
        expect(withKey1).not.toBe(withKey2);
    });
});

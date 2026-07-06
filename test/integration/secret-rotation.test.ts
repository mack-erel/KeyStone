import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ensureDefaultTenant } from "../../src/lib/server/auth/bootstrap";
import { generateRsaSigningKey, wrapPrivateKey, getActiveSigningKey, invalidateSigningKeyCache, encryptSecret, decryptSecret, tryWithSecrets } from "../../src/lib/server/crypto/keys";
import { signingKeys } from "../../src/lib/server/db/schema";
import { openMemoryDb, makePlatform, TEST_SIGNING_SECRET, TEST_SIGNING_SECRET_PREVIOUS, type MemoryDb } from "./harness";
import type { Tenant } from "../../src/lib/server/db/schema";

// Phase 9: 무중단 시크릿 회전. 발급/암호화는 항상 current 만 쓰되, 복호/검증은 current→previous
// 순차 fallback 한다. "previous 로 암호화된 데이터가 회전(current 승격) 후에도 복호되는지" 를
// 실 DB 서명키 행 + 실제 getActiveSigningKey/tryWithSecrets 경로로 검증한다.

let mem: MemoryDb;
let tenant: Tenant;

beforeEach(async () => {
    mem = await openMemoryDb();
    tenant = await ensureDefaultTenant(mem.db, makePlatform(mem.env));
});

afterEach(() => {
    invalidateSigningKeyCache(tenant.id);
    mem.close();
});

describe("Phase 9 — 시크릿 current/previous fallback", () => {
    it("previous 로 래핑된 서명키를 current 로만은 복호 못 하고, [current, previous] fallback 으로 복호한다", async () => {
        // 회전 이전 시점에 previous(=과거 current)로 private key 를 래핑해 저장했다고 가정.
        const { kid, privateKey, publicJwk } = await generateRsaSigningKey();
        const privateJwkEncrypted = await wrapPrivateKey(privateKey, TEST_SIGNING_SECRET_PREVIOUS);
        await mem.db.insert(signingKeys).values({
            id: crypto.randomUUID(),
            tenantId: tenant.id,
            kid,
            use: "sig",
            alg: "RS256",
            publicJwk: JSON.stringify(publicJwk),
            privateJwkEncrypted,
            active: true,
        });

        // current(신규 시크릿) 단독으로는 unwrap 실패 → tryWithSecrets 가 마지막 에러를 throw.
        invalidateSigningKeyCache(tenant.id);
        await expect(getActiveSigningKey(mem.db, tenant.id, [TEST_SIGNING_SECRET])).rejects.toThrow();

        // [current, previous] fallback 으로는 previous 로 성공 복호 → 활성 키 반환.
        invalidateSigningKeyCache(tenant.id);
        const key = await getActiveSigningKey(mem.db, tenant.id, [TEST_SIGNING_SECRET, TEST_SIGNING_SECRET_PREVIOUS]);
        expect(key).not.toBeNull();
        expect(key!.kid).toBe(kid);
        // 실제 복호된 privateKey 로 서명이 가능한지(RS256 sign)까지 확인.
        const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key!.privateKey, new TextEncoder().encode("payload"));
        expect(sig.byteLength).toBeGreaterThan(0);
    });

    it("previous 로 암호화한 일반 시크릿(LDAP bindPassword 형식)이 회전 후 [current, previous] 로 복호된다", async () => {
        const plaintext = "ldap-bind-password-super-secret";
        const context = "idp-ldap-bind-password-v1";
        // 회전 전: previous 시크릿으로 암호화된 값이 DB(configJson)에 남아 있는 상태.
        const encrypted = await encryptSecret(plaintext, TEST_SIGNING_SECRET_PREVIOUS, context);

        // 회전 후 current 단독 복호는 실패.
        await expect(decryptSecret(encrypted, TEST_SIGNING_SECRET, context)).rejects.toThrow();

        // current→previous fallback(실 로그인 경로와 동일 패턴)은 성공.
        const decrypted = await tryWithSecrets([TEST_SIGNING_SECRET, TEST_SIGNING_SECRET_PREVIOUS], (s) => decryptSecret(encrypted, s, context));
        expect(decrypted).toBe(plaintext);
    });

    it("발급/암호화는 current 로만 수행한다 — current 로 래핑한 키는 current 단독으로 복호된다", async () => {
        const { kid, privateKey, publicJwk } = await generateRsaSigningKey();
        const privateJwkEncrypted = await wrapPrivateKey(privateKey, TEST_SIGNING_SECRET);
        await mem.db.insert(signingKeys).values({
            id: crypto.randomUUID(),
            tenantId: tenant.id,
            kid,
            use: "sig",
            alg: "RS256",
            publicJwk: JSON.stringify(publicJwk),
            privateJwkEncrypted,
            active: true,
        });
        invalidateSigningKeyCache(tenant.id);
        const key = await getActiveSigningKey(mem.db, tenant.id, [TEST_SIGNING_SECRET]);
        expect(key!.kid).toBe(kid);
    });
});

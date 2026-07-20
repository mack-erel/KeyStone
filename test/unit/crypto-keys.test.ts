import { describe, it, expect, beforeAll } from "vitest";
import type { DB } from "$lib/server/db";
import {
    b64uEncode,
    b64uDecode,
    generateRsaSigningKey,
    signJwt,
    verifyIdToken,
    generateAccessToken,
    verifyAccessToken,
    wrapPrivateKey,
    unwrapPrivateKey,
    encryptSecret,
    decryptSecret,
    tryWithSecrets,
    tryWithSecretsNullable,
    type AccessTokenClaims,
} from "$lib/server/crypto/keys";

// ── 독립 교차 검증 헬퍼 ────────────────────────────────────────────────────────
// keys.ts 의 b64u 구현에 의존하지 않는 별도 base64url 디코더 (tautology 회피용).
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const bin = atob(b64 + pad);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
}
function b64urlToString(s: string): string {
    return new TextDecoder().decode(b64urlToBytes(s));
}

const nowSec = () => Math.floor(Date.now() / 1000);

// verifyIdToken 은 db 파라미터로 공개 JWK 행을 조회한다. 실제 암호 검증 로직
// (서명/typ/crit/events/exp/aud/iss) 을 그대로 태우기 위한 최소 쿼리빌더 스텁.
function fakeDb(publicJwk: JsonWebKey | null): DB {
    const rows = publicJwk ? [{ publicJwk: JSON.stringify(publicJwk) }] : [];
    return {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
    } as unknown as DB;
}

describe("b64u 헬퍼", () => {
    it("인코딩→디코딩 라운드트립 + 독립 디코더와 교차 일치", () => {
        const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 42, 7]);
        const encoded = b64uEncode(bytes);
        // padding 없음 + url-safe 문자만
        expect(encoded).not.toMatch(/[+/=]/);
        expect(Array.from(b64uDecode(encoded))).toEqual(Array.from(bytes));
        // 독립 디코더로도 동일 결과
        expect(Array.from(b64urlToBytes(encoded))).toEqual(Array.from(bytes));
    });
});

describe("RS256 JWT (signJwt / verifyIdToken)", () => {
    let key: Awaited<ReturnType<typeof generateRsaSigningKey>>;

    beforeAll(async () => {
        key = await generateRsaSigningKey();
    });

    it("signJwt 결과를 WebCrypto 로 직접 검증 (독립 교차검증)", async () => {
        const payload = { sub: "user-1", aud: "client-a", iss: "https://idp.example", exp: nowSec() + 3600, iat: nowSec() };
        const token = await signJwt(payload, key.privateKey, key.kid);
        const [h, p, s] = token.split(".");

        // 헤더/페이로드를 독립 디코더로 파싱
        const header = JSON.parse(b64urlToString(h)) as Record<string, unknown>;
        expect(header.alg).toBe("RS256");
        expect(header.typ).toBe("JWT");
        expect(header.kid).toBe(key.kid);
        expect(JSON.parse(b64urlToString(p))).toEqual(payload);

        // jose 없이 공개 JWK 를 import 해 서명을 직접 검증
        const pub = await crypto.subtle.importKey("jwk", key.publicJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
        expect(ok).toBe(true);
    });

    it("custom typ 헤더가 반영된다", async () => {
        const token = await signJwt({ sub: "x" }, key.privateKey, key.kid, { typ: "logout+jwt" });
        const header = JSON.parse(b64urlToString(token.split(".")[0])) as Record<string, unknown>;
        expect(header.typ).toBe("logout+jwt");
    });

    it("유효 토큰: verifyIdToken 이 claims 반환 (aud/iss 일치)", async () => {
        const payload = { sub: "user-1", aud: "client-a", iss: "https://idp.example", exp: nowSec() + 3600 };
        const token = await signJwt(payload, key.privateKey, key.kid);
        const claims = await verifyIdToken(fakeDb(key.publicJwk), "tenant-1", token, { expectedAud: "client-a", expectedIssuer: "https://idp.example" });
        expect(claims).not.toBeNull();
        expect(claims!.sub).toBe("user-1");
    });

    it("변조된 서명 거부", async () => {
        const token = await signJwt({ sub: "u", aud: "client-a", exp: nowSec() + 3600 }, key.privateKey, key.kid);
        const [h, p, s] = token.split(".");
        // 서명 첫 문자 치환 — 마지막 base64url 문자는 미사용(패딩) 비트만 담을 수 있어
        // 같은 바이트로 디코드될 수 있으므로 유효 비트가 확실한 첫 문자를 바꾼다.
        const tamperedChar = s[0] === "A" ? "B" : "A";
        const tampered = `${h}.${p}.${tamperedChar}${s.slice(1)}`;
        expect(await verifyIdToken(fakeDb(key.publicJwk), "tenant-1", tampered)).toBeNull();
    });

    it("잘못된 aud 거부", async () => {
        const token = await signJwt({ sub: "u", aud: "client-a", exp: nowSec() + 3600 }, key.privateKey, key.kid);
        expect(await verifyIdToken(fakeDb(key.publicJwk), "tenant-1", token, { expectedAud: "client-b" })).toBeNull();
    });

    it("만료 토큰 거부 (ignoreExpiry 로는 통과)", async () => {
        const token = await signJwt({ sub: "u", aud: "client-a", exp: nowSec() - 10 }, key.privateKey, key.kid);
        expect(await verifyIdToken(fakeDb(key.publicJwk), "tenant-1", token, { expectedAud: "client-a" })).toBeNull();
        // 만료 무시 옵션에서는 서명 유효 → 통과
        const claims = await verifyIdToken(fakeDb(key.publicJwk), "tenant-1", token, { expectedAud: "client-a", ignoreExpiry: true });
        expect(claims).not.toBeNull();
    });

    it("type-confusion 방어: 비-JWT typ / events claim 거부", async () => {
        const logoutTyped = await signJwt({ sub: "u", exp: nowSec() + 3600 }, key.privateKey, key.kid, { typ: "logout+jwt" });
        expect(await verifyIdToken(fakeDb(key.publicJwk), "tenant-1", logoutTyped)).toBeNull();

        const withEvents = await signJwt({ sub: "u", exp: nowSec() + 3600, events: { "http://schemas.openid.net/event/backchannel-logout": {} } }, key.privateKey, key.kid);
        expect(await verifyIdToken(fakeDb(key.publicJwk), "tenant-1", withEvents)).toBeNull();
    });

    it("kid 미매칭(행 없음) 거부", async () => {
        const token = await signJwt({ sub: "u", exp: nowSec() + 3600 }, key.privateKey, key.kid);
        expect(await verifyIdToken(fakeDb(null), "tenant-1", token)).toBeNull();
    });

    it("잘못된 형식(파트 수 불일치) 거부", async () => {
        expect(await verifyIdToken(fakeDb(key.publicJwk), "tenant-1", "not.a.jwt.token")).toBeNull();
        expect(await verifyIdToken(fakeDb(key.publicJwk), "tenant-1", "onlyone")).toBeNull();
    });
});

describe("HMAC opaque access token (generate/verifyAccessToken)", () => {
    const secret = "hmac-secret-abcdefghijklmnop-1234567890";
    const baseClaims = (over: Partial<AccessTokenClaims> = {}): AccessTokenClaims => ({
        sub: "user-1",
        tenantId: "tenant-1",
        clientId: "client-a",
        scope: "openid profile",
        exp: nowSec() + 3600,
        iat: nowSec(),
        aud: "client-a",
        iss: "https://idp.example",
        ...over,
    });

    it("발급 → 검증 라운드트립", async () => {
        const claims = baseClaims();
        const token = await generateAccessToken(claims, secret);
        const verified = await verifyAccessToken(token, secret, "tenant-1", "client-a");
        expect(verified).toEqual(claims);
    });

    it("HMAC 서명을 WebCrypto 로 직접 검증 (독립 교차검증)", async () => {
        // ctrls R10: access-token HMAC 키는 raw secret 이 아니라 HKDF 파생 서브키다.
        // 교차검증도 동일 salt/info 로 키를 독립 재현해 raw 서명을 검증한다.
        const token = await generateAccessToken(baseClaims(), secret);
        const [data, sig] = token.split(".");
        const enc = new TextEncoder();
        const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
        const macKey = await crypto.subtle.deriveKey(
            { name: "HKDF", hash: "SHA-256", salt: enc.encode("idp-access-token-hmac-salt-v1"), info: enc.encode("idp-access-token-hmac-v1") },
            ikm,
            { name: "HMAC", hash: "SHA-256", length: 256 },
            false,
            ["verify"],
        );
        const ok = await crypto.subtle.verify("HMAC", macKey, b64urlToBytes(sig), enc.encode(data));
        expect(ok).toBe(true);
        // raw secret 을 그대로 HMAC 키로 쓰던 이전 방식으로는 더 이상 검증되지 않아야 한다(키 분리 확인).
        const legacyKey = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
        expect(await crypto.subtle.verify("HMAC", legacyKey, b64urlToBytes(sig), enc.encode(data))).toBe(false);
    });

    it("R10 전환기: legacy(raw-key)로 서명된 미만료 토큰도 검증된다(하위호환)", async () => {
        // 이전 방식(raw secret 을 직접 HMAC 키로)으로 토큰을 만들어 verifyAccessToken 이 폴백 검증하는지 확인.
        const enc = new TextEncoder();
        const data = b64uEncode(enc.encode(JSON.stringify(baseClaims())));
        const legacyKey = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const legacySig = await crypto.subtle.sign("HMAC", legacyKey, enc.encode(data));
        const legacyToken = `${data}.${b64uEncode(new Uint8Array(legacySig))}`;
        const verified = await verifyAccessToken(legacyToken, secret, "tenant-1", "client-a");
        expect(verified).not.toBeNull();
        expect(verified!.sub).toBe(baseClaims().sub);
    });

    it("페이로드 변조 거부 (서명 미갱신)", async () => {
        const token = await generateAccessToken(baseClaims(), secret);
        const [, sig] = token.split(".");
        const forged = { ...baseClaims(), sub: "attacker" };
        const forgedData = b64uEncode(new TextEncoder().encode(JSON.stringify(forged)));
        expect(await verifyAccessToken(`${forgedData}.${sig}`, secret, "tenant-1")).toBeNull();
    });

    it("서명 변조 거부", async () => {
        const token = await generateAccessToken(baseClaims(), secret);
        const [data, sig] = token.split(".");
        // 첫 문자 치환 (마지막 문자는 미사용 비트만 담아 같은 바이트로 디코드될 수 있음).
        const ch = sig[0] === "A" ? "B" : "A";
        expect(await verifyAccessToken(`${data}.${ch}${sig.slice(1)}`, secret, "tenant-1")).toBeNull();
    });

    it("만료 거부", async () => {
        const token = await generateAccessToken(baseClaims({ exp: nowSec() - 10 }), secret);
        expect(await verifyAccessToken(token, secret, "tenant-1")).toBeNull();
    });

    it("tenant 불일치 거부", async () => {
        const token = await generateAccessToken(baseClaims(), secret);
        expect(await verifyAccessToken(token, secret, "tenant-OTHER")).toBeNull();
    });

    it("aud 불일치 거부", async () => {
        const token = await generateAccessToken(baseClaims(), secret);
        expect(await verifyAccessToken(token, secret, "tenant-1", "client-B")).toBeNull();
    });

    it("잘못된 secret 거부", async () => {
        const token = await generateAccessToken(baseClaims(), secret);
        expect(await verifyAccessToken(token, "wrong-secret", "tenant-1")).toBeNull();
    });
});

describe("private key 래핑 (wrapPrivateKey / unwrapPrivateKey)", () => {
    let key: Awaited<ReturnType<typeof generateRsaSigningKey>>;
    const secret = "wrap-secret-0123456789";

    beforeAll(async () => {
        key = await generateRsaSigningKey();
    });

    it("래핑 → 언래핑 라운드트립 (복원 키로 서명한 값이 원본 공개키로 검증됨)", async () => {
        const wrapped = await wrapPrivateKey(key.privateKey, secret);
        expect(wrapped.split(".")).toHaveLength(3); // salt.iv.ct
        const unwrapped = await unwrapPrivateKey(wrapped, secret);
        const msg = new TextEncoder().encode("payload-to-sign");
        const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", unwrapped, msg);
        const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key.publicKey, sig, msg);
        expect(ok).toBe(true);
    });

    it("잘못된 secret 으로 언래핑 실패 (AES-GCM 인증 태그)", async () => {
        const wrapped = await wrapPrivateKey(key.privateKey, secret);
        await expect(unwrapPrivateKey(wrapped, "wrong-secret")).rejects.toThrow();
    });

    it("잘못된 형식 거부", async () => {
        await expect(unwrapPrivateKey("only.two", secret)).rejects.toThrow(/Invalid encrypted key format/);
    });
});

describe("secret 암호화 + HKDF 도메인 분리 (encryptSecret / decryptSecret)", () => {
    const secret = "master-secret-abcdef-0123456789";

    it("기본 context 라운드트립", async () => {
        const enc = await encryptSecret("hello world", secret);
        expect(enc.split(".")).toHaveLength(3);
        expect(await decryptSecret(enc, secret)).toBe("hello world");
    });

    it("커스텀 context 라운드트립", async () => {
        const enc = await encryptSecret("payload", secret, "context-A");
        expect(await decryptSecret(enc, secret, "context-A")).toBe("payload");
    });

    it("도메인 분리: 다른 context 로는 복호화 불가", async () => {
        const enc = await encryptSecret("payload", secret, "context-A");
        // 같은 secret 이라도 HKDF info(context) 가 다르면 파생 키가 달라 복호 실패
        await expect(decryptSecret(enc, secret, "context-B")).rejects.toThrow();
        // 기본 context 로도 실패 (context-A 로 암호화했으므로)
        await expect(decryptSecret(enc, secret)).rejects.toThrow();
    });

    it("잘못된 masterSecret 으로 복호화 실패", async () => {
        const enc = await encryptSecret("payload", secret, "context-A");
        await expect(decryptSecret(enc, "wrong-master", "context-A")).rejects.toThrow();
    });

    it("잘못된 형식 거부", async () => {
        await expect(decryptSecret("only.two", secret)).rejects.toThrow(/Invalid encrypted secret format/);
    });
});

// ── 무중단 회전 헬퍼 (tryWithSecrets / tryWithSecretsNullable) ──────────────────
describe("무중단 시크릿 회전 (tryWithSecrets)", () => {
    const CURRENT = "new-master-secret-abcdef";
    const PREVIOUS = "old-master-secret-012345";

    it("throwing 변형: current 로 복호 성공 시 previous 는 시도하지 않는다", async () => {
        // current 로 암호화된 값 → [current, previous] 로 즉시 성공.
        const enc = await encryptSecret("payload", CURRENT, "ctx");
        const tried: string[] = [];
        const out = await tryWithSecrets([CURRENT, PREVIOUS], (s) => {
            tried.push(s);
            return decryptSecret(enc, s, "ctx");
        });
        expect(out).toBe("payload");
        expect(tried).toEqual([CURRENT]); // previous 미시도
    });

    it("throwing 변형: current 실패 시 previous 로 fallback 복호", async () => {
        // previous 로 암호화된 (회전 전) 값 → current 실패 후 previous 성공.
        const encOld = await encryptSecret("legacy", PREVIOUS, "ctx");
        const tried: string[] = [];
        const out = await tryWithSecrets([CURRENT, PREVIOUS], (s) => {
            tried.push(s);
            return decryptSecret(encOld, s, "ctx");
        });
        expect(out).toBe("legacy");
        expect(tried).toEqual([CURRENT, PREVIOUS]);
    });

    it("throwing 변형: 전부 실패 시 마지막 에러를 throw", async () => {
        const encOther = await encryptSecret("x", "totally-different-secret", "ctx");
        await expect(tryWithSecrets([CURRENT, PREVIOUS], (s) => decryptSecret(encOther, s, "ctx"))).rejects.toThrow();
    });

    it("throwing 변형: 빈 시크릿 배열은 즉시 throw (미설정 방어)", async () => {
        await expect(tryWithSecrets([], async () => "x")).rejects.toThrow();
    });

    it("nullable 변형: 최초 non-null 을 반환하고 이후 시크릿은 시도하지 않는다", async () => {
        const claims: AccessTokenClaims = { sub: "u", tenantId: "t", clientId: "c", scope: "openid", iat: 0, exp: Math.floor(Date.now() / 1000) + 300 };
        const token = await generateAccessToken(claims, CURRENT);
        const tried: string[] = [];
        const out = await tryWithSecretsNullable([CURRENT, PREVIOUS], (s) => {
            tried.push(s);
            return verifyAccessToken(token, s, "t");
        });
        expect(out?.sub).toBe("u");
        expect(tried).toEqual([CURRENT]);
    });

    it("nullable 변형: current(null) → previous 로 fallback", async () => {
        const claims: AccessTokenClaims = { sub: "u2", tenantId: "t", clientId: "c", scope: "openid", iat: 0, exp: Math.floor(Date.now() / 1000) + 300 };
        // previous 로 서명된 (회전 전 발급) 토큰.
        const token = await generateAccessToken(claims, PREVIOUS);
        const tried: string[] = [];
        const out = await tryWithSecretsNullable([CURRENT, PREVIOUS], (s) => {
            tried.push(s);
            return verifyAccessToken(token, s, "t");
        });
        expect(out?.sub).toBe("u2");
        expect(tried).toEqual([CURRENT, PREVIOUS]);
    });

    it("nullable 변형: 전부 null 이면 null", async () => {
        const claims: AccessTokenClaims = { sub: "u3", tenantId: "t", clientId: "c", scope: "openid", iat: 0, exp: Math.floor(Date.now() / 1000) + 300 };
        const token = await generateAccessToken(claims, "some-other-secret");
        const out = await tryWithSecretsNullable([CURRENT, PREVIOUS], (s) => verifyAccessToken(token, s, "t"));
        expect(out).toBeNull();
    });
});

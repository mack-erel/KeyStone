import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "$env/dynamic/private";
import type { DB } from "$lib/server/db";
import { generateToken, hashToken } from "$lib/server/email";
import { issueEmailVerification, EMAIL_VERIFY_EXPIRY_MS } from "$lib/server/auth/email-verification";

// ── mock 설계 요약 ────────────────────────────────────────────────────────────
// 대상 계약:
//   generateToken()          : CSPRNG 32바이트 → hex 토큰 + SHA-256 hex 해시.
//   issueEmailVerification() : db.insert(emailVerificationTokens).values({userId,tokenHash,expiresAt})
//                              (평문 토큰 미저장). 발송 실패/issuer 미설정을 격리.
// env 는 vitest 스텁($env/dynamic/private, 빈 가변 객체)을 공유하므로 테스트에서
// IDP_ISSUER_URL 를 주입/제거해 분기를 제어한다. SMTP_* 미설정 → 실제 발송은 throw
// 하지만 issueEmailVerification 내부 .catch/try 로 격리되어 상위로 새지 않아야 한다.
function makeDb(onInsert?: () => void) {
    const inserts: Record<string, unknown>[] = [];
    const db = {
        insert: () => ({
            values: async (v: Record<string, unknown>) => {
                if (onInsert) onInsert();
                inserts.push(v);
            },
        }),
    };
    return { db: db as unknown as DB, inserts };
}

const HEX64 = /^[0-9a-f]{64}$/;

// env($env/dynamic/private)는 선언상 필수 string 속성이라 delete가 막힌다.
// 동일 객체를 optional 뷰로만 캐스팅해(런타임 동작 동일) 키 제거를 허용한다.
const mutEnv = env as Record<string, string | undefined>;

beforeEach(() => {
    // 발송 경로가 실제 네트워크를 타지 않도록 SMTP 미설정 유지(발송은 throw→격리 검증).
    delete mutEnv.IDP_ISSUER_URL;
    delete mutEnv.SMTP_HOSTNAME;
    delete mutEnv.SMTP_PORTNUMB;
    delete mutEnv.SMTP_USERNAME;
    delete mutEnv.SMTP_PASSWORD;
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    delete mutEnv.IDP_ISSUER_URL;
});

describe("generateToken — CSPRNG 32바이트 / SHA-256 해시", () => {
    it("token 은 64 hex(32바이트) URL-safe, tokenHash 는 token 의 SHA-256 hex", async () => {
        const { token, tokenHash } = await generateToken();
        expect(HEX64.test(token)).toBe(true); // hex → URL-safe
        expect(HEX64.test(tokenHash)).toBe(true);
        expect(tokenHash).not.toBe(token);
        // 해시 계약: tokenHash === SHA-256(token)
        expect(tokenHash).toBe(await hashToken(token));
    });

    it("호출마다 다른 토큰(CSPRNG 무작위성)", async () => {
        const a = await generateToken();
        const b = await generateToken();
        expect(a.token).not.toBe(b.token);
        expect(a.tokenHash).not.toBe(b.tokenHash);
    });
});

describe("issueEmailVerification — 토큰 저장/TTL/격리", () => {
    it("issuer 설정 시 tokenHash(SHA-256)만 insert, 평문 토큰은 저장 안 함", async () => {
        env.IDP_ISSUER_URL = "https://idp.example.com";
        const { db, inserts } = makeDb();
        const before = Date.now();
        await issueEmailVerification(db, "user-1", "u@example.com", "ko", undefined);

        expect(inserts.length).toBe(1);
        const v = inserts[0];
        expect(v.userId).toBe("user-1");
        expect(HEX64.test(v.tokenHash as string)).toBe(true); // 해시만 저장
        expect(v.token).toBeUndefined(); // 평문 토큰 컬럼 없음
        // TTL 24h.
        const exp = (v.expiresAt as Date).getTime();
        expect(exp).toBeGreaterThanOrEqual(before + EMAIL_VERIFY_EXPIRY_MS - 2000);
        expect(exp).toBeLessThanOrEqual(Date.now() + EMAIL_VERIFY_EXPIRY_MS + 2000);
        expect(EMAIL_VERIFY_EXPIRY_MS).toBe(24 * 60 * 60 * 1000);
    });

    it("발송 실패(SMTP 미설정 → send throw)가 상위로 새지 않고 격리된다", async () => {
        env.IDP_ISSUER_URL = "https://idp.example.com";
        // SMTP_* 미설정이므로 sendEmailVerificationEmail 내부에서 throw 하지만
        // .catch/try 로 삼켜야 한다 — resolve 되어야 한다(토큰 insert 는 성공).
        const { db, inserts } = makeDb();
        await expect(issueEmailVerification(db, "user-1", "u@example.com", "ko", undefined)).resolves.toBeUndefined();
        expect(inserts.length).toBe(1);
    });

    it("IDP_ISSUER_URL 미설정 시 발송/저장 스킵(insert 없음)", async () => {
        // beforeEach 에서 IDP_ISSUER_URL 삭제됨.
        const { db, inserts } = makeDb();
        await expect(issueEmailVerification(db, "user-1", "u@example.com", "ko", undefined)).resolves.toBeUndefined();
        expect(inserts.length).toBe(0);
    });

    it("토큰 발급/insert 예외도 격리되어 상위로 전파되지 않는다", async () => {
        env.IDP_ISSUER_URL = "https://idp.example.com";
        const db = makeDb(() => {
            throw new Error("db down");
        }).db;
        await expect(issueEmailVerification(db, "user-1", "u@example.com", "ko", undefined)).resolves.toBeUndefined();
    });
});

import { env } from "$env/dynamic/private";
import type { Locale } from "$lib/i18n/core";
import type { DB } from "$lib/server/db";
import { emailVerificationTokens } from "$lib/server/db/schema";
import { generateToken, sendEmailVerificationEmail } from "$lib/server/email";

export const EMAIL_VERIFY_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24시간

/**
 * F1: 이메일 인증 토큰 발급 + 인증 메일 발송(공통 — 가입/재발송에서 사용).
 * 발송 실패가 상위 흐름(가입/재발송 응답)을 실패시키지 않도록 완전 격리한다:
 *  - issuer(IDP_ISSUER_URL) 미설정 시 발송 스킵(host header injection 방지 목적).
 *  - Workers 는 waitUntil 로 응답 경로에서 분리, Node 는 await.
 *  - 토큰 발급/발송 예외는 삼켜서 호출부에 전파하지 않는다.
 */
export async function issueEmailVerification(db: DB, userId: string, email: string, locale: Locale, platform: App.Platform | undefined): Promise<void> {
    const issuer = env.IDP_ISSUER_URL?.replace(/\.+$/, "").replace(/\/+$/, "");
    if (!issuer) {
        console.error("[email-verification] IDP_ISSUER_URL 미설정 — 이메일 인증 메일 발송 불가");
        return;
    }
    try {
        const { token, tokenHash } = await generateToken();
        const expiresAt = new Date(Date.now() + EMAIL_VERIFY_EXPIRY_MS);
        await db.insert(emailVerificationTokens).values({ userId, tokenHash, expiresAt });
        const verifyUrl = `${issuer}/verify-email?token=${encodeURIComponent(token)}`;
        const sendPromise = sendEmailVerificationEmail(email, verifyUrl, locale, platform).catch(() => {
            // 발송 실패는 조용히 무시
        });
        const wait = platform?.ctx?.waitUntil?.bind(platform.ctx);
        if (wait) wait(sendPromise);
        else await sendPromise;
    } catch {
        // 토큰 발급/발송 실패가 상위 흐름을 실패시키지 않도록 격리
    }
}

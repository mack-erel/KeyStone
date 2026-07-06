import { env } from "$env/dynamic/private";
import { and, eq, isNull } from "drizzle-orm";
import type { Locale } from "$lib/i18n/core";
import type { DB } from "$lib/server/db";
import { emailChangeTokens } from "$lib/server/db/schema";
import { generateToken, sendEmailChangeVerificationEmail } from "$lib/server/email";

export const EMAIL_CHANGE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24시간

/**
 * F3: 이메일 변경 확인 토큰 발급 + 새 주소로 확인 메일 발송(best-effort, 완전 격리).
 * issueEmailVerification 과 동일한 격리 규약을 따른다:
 *  - issuer(IDP_ISSUER_URL) 미설정 시 발송 스킵(host header injection 방지 목적).
 *  - Workers 는 waitUntil 로 응답 경로에서 분리, Node 는 await.
 *  - 토큰 발급/발송 예외는 삼켜서 호출부(변경 요청 응답)에 전파하지 않는다.
 *
 * 토큰에는 변경 대상 주소(targetEmail)를 바인딩한다 — 확인 라우트가 이 값으로만 email 을
 * 교체하므로, 링크가 다른 주소로 재사용되거나 대기값이 바뀌어도 확인 대상이 어긋나지 않는다.
 * 같은 user 의 기존 미사용 변경 토큰은 새 토큰 발급 전에 모두 소진해 최신 요청만 유효하게 한다.
 */
export async function issueEmailChange(db: DB, userId: string, targetEmail: string, locale: Locale, platform: App.Platform | undefined): Promise<void> {
    const issuer = env.IDP_ISSUER_URL?.replace(/\.+$/, "").replace(/\/+$/, "");
    if (!issuer) {
        console.error("[email-change] IDP_ISSUER_URL 미설정 — 이메일 변경 확인 메일 발송 불가");
        return;
    }
    try {
        // 같은 user 의 미사용 변경 토큰을 모두 소진 처리 → 새 토큰만 유효.
        await db
            .update(emailChangeTokens)
            .set({ usedAt: new Date() })
            .where(and(eq(emailChangeTokens.userId, userId), isNull(emailChangeTokens.usedAt)));

        const { token, tokenHash } = await generateToken();
        const expiresAt = new Date(Date.now() + EMAIL_CHANGE_EXPIRY_MS);
        await db.insert(emailChangeTokens).values({ userId, tokenHash, targetEmail, expiresAt });

        const confirmUrl = `${issuer}/account/confirm-email-change?token=${encodeURIComponent(token)}`;
        const sendPromise = sendEmailChangeVerificationEmail(targetEmail, confirmUrl, locale, platform).catch(() => {
            // 발송 실패는 조용히 무시
        });
        const wait = platform?.ctx?.waitUntil?.bind(platform.ctx);
        if (wait) wait(sendPromise);
        else await sendPromise;
    } catch {
        // 토큰 발급/발송 실패가 상위 흐름을 실패시키지 않도록 격리
    }
}

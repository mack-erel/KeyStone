import { env } from "$env/dynamic/private";
import type { Locale } from "$lib/i18n/core";
import type { DB } from "$lib/server/db";
import { inviteTokens } from "$lib/server/db/schema";
import { generateToken, sendInviteEmail } from "$lib/server/email";

export const INVITE_EXPIRY_MS = 72 * 60 * 60 * 1000; // 72시간

/**
 * 초대 토큰 발급 + 초대 메일 발송(admin invite 액션에서 사용).
 * email-verification.ts 의 issueEmailVerification 과 동일한 격리 규약을 따른다:
 *  - issuer(IDP_ISSUER_URL) 미설정 시 발송 스킵(host header injection 방지 목적).
 *  - Workers 는 waitUntil 로 응답 경로에서 분리, Node 는 await.
 *  - 토큰 발급/발송 예외는 삼켜서 호출부(계정 생성 응답)에 전파하지 않는다(best-effort).
 */
export async function issueInvite(db: DB, userId: string, email: string, locale: Locale, platform: App.Platform | undefined): Promise<void> {
    const issuer = env.IDP_ISSUER_URL?.replace(/\.+$/, "").replace(/\/+$/, "");
    if (!issuer) {
        console.error("[invite] IDP_ISSUER_URL 미설정 — 초대 메일 발송 불가");
        return;
    }
    try {
        const { token, tokenHash } = await generateToken();
        const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS);
        await db.insert(inviteTokens).values({ userId, tokenHash, expiresAt });
        const inviteUrl = `${issuer}/accept-invite?token=${encodeURIComponent(token)}`;
        const sendPromise = sendInviteEmail(email, inviteUrl, locale, platform).catch(() => {
            // 발송 실패는 조용히 무시
        });
        const wait = platform?.ctx?.waitUntil?.bind(platform.ctx);
        if (wait) wait(sendPromise);
        else await sendPromise;
    } catch {
        // 토큰 발급/발송 실패가 상위 흐름을 실패시키지 않도록 격리
    }
}

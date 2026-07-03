/**
 * ctrls H-OIDC-5: 관리자 상태 변경 폼용 명시적 CSRF 토큰 (double-submit cookie).
 *
 * 전역 hooks.server.ts 의 Origin/Referer 검사가 1차 방어선이지만, 민감한 admin
 * 액션(클라이언트 시크릿 재생성/삭제 등)에는 동기화 토큰을 추가로 요구해
 * defense-in-depth 를 둔다.
 *
 * 동작:
 *   - load 에서 `ensureCsrfToken` 을 호출해 토큰을 쿠키에 심고 페이지 데이터로 반환.
 *   - 폼은 이 토큰을 hidden 필드(`csrf`)로 제출.
 *   - 액션은 `isValidCsrf` 로 쿠키 값과 폼 값을 상수시간 비교.
 *
 * 토큰은 서버가 심은 httpOnly 쿠키에 저장되고 폼에는 서버 렌더링 데이터로 주입되므로,
 * 교차 출처 공격자는 쿠키(SameSite)도 페이지 데이터(SOP)도 읽을 수 없어 일치하는
 * 폼 값을 위조할 수 없다.
 */

import type { Cookies } from "@sveltejs/kit";

export const CSRF_COOKIE_NAME = "idp_csrf";
const CSRF_MAX_AGE_S = 60 * 60 * 8; // 8시간

function cookieOptions(url: URL) {
    return {
        path: "/",
        httpOnly: true,
        sameSite: "lax" as const,
        secure: url.protocol === "https:",
        maxAge: CSRF_MAX_AGE_S,
    };
}

/** load 에서 호출: 유효한 CSRF 토큰이 있으면 재사용, 없으면 생성해 쿠키에 심고 반환. */
export function ensureCsrfToken(cookies: Cookies, url: URL): string {
    const existing = cookies.get(CSRF_COOKIE_NAME);
    if (existing && existing.length >= 32) return existing;
    // 256bit — UUID 두 개(각 122bit) 연결.
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    cookies.set(CSRF_COOKIE_NAME, token, cookieOptions(url));
    return token;
}

/** double-submit 검증: 폼의 `csrf` 필드가 쿠키 토큰과 상수시간 일치하는지. */
export function isValidCsrf(cookies: Cookies, formData: FormData): boolean {
    const cookieToken = cookies.get(CSRF_COOKIE_NAME) ?? "";
    const formToken = String(formData.get("csrf") ?? "");
    if (!cookieToken || !formToken) return false;
    return timingSafeEqual(cookieToken, formToken);
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

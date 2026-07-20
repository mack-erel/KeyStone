/**
 * ctrls R5: 유출 비밀번호(HIBP) 스크리닝.
 *
 * Have I Been Pwned 의 range API 를 k-anonymity 방식으로 조회한다 — 비밀번호 SHA-1 해시의
 * 앞 5자(prefix)만 전송하고, 나머지(suffix)는 로컬에서 대조하므로 원문/전체 해시가 외부로
 * 나가지 않는다. `Add-Padding: true` 로 응답 크기 기반 유추도 차단한다.
 *
 * 기본 비활성(opt-in): 외부 서비스(api.pwnedpasswords.com) 가용성에 회원가입/비번재설정
 * 핫패스를 하드 의존시키지 않기 위해, 운영자가 `PASSWORD_BREACH_CHECK=true` 로 명시 활성화한
 * 경우에만 동작한다. 활성 상태에서도 API 오류/타임아웃은 fail-open(가입을 막지 않음)한다.
 */

import { env } from "$env/dynamic/private";

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const HIBP_TIMEOUT_MS = 3000;

/** 운영자가 HIBP 스크리닝을 켰는지. */
export function isBreachCheckEnabled(): boolean {
    return env.PASSWORD_BREACH_CHECK === "true";
}

async function sha1HexUpper(input: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex.toUpperCase();
}

/**
 * 비밀번호가 알려진 유출 코퍼스에 존재하는지. 활성화 여부와 무관하게 순수 조회 로직만 담는다
 * (호출부에서 isBreachCheckEnabled() 로 게이트). API 오류/타임아웃 시 false(fail-open).
 */
export async function isPasswordBreached(password: string): Promise<boolean> {
    try {
        const hash = await sha1HexUpper(password);
        const prefix = hash.slice(0, 5);
        const suffix = hash.slice(5);

        const res = await fetch(`${HIBP_RANGE_URL}${prefix}`, {
            headers: { "Add-Padding": "true" },
            signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
        });
        if (!res.ok) return false;

        const text = await res.text();
        for (const line of text.split("\n")) {
            const sep = line.indexOf(":");
            if (sep === -1) continue;
            const suf = line.slice(0, sep).trim().toUpperCase();
            // 패딩 항목은 count=0 으로 내려오므로 count>0 만 유출로 본다.
            const count = Number(line.slice(sep + 1).trim());
            if (suf === suffix && count > 0) return true;
        }
        return false;
    } catch {
        return false; // 네트워크 오류/타임아웃 → fail-open
    }
}

import { error } from "@sveltejs/kit";
import type { RuntimeConfig } from "./runtime";

/**
 * stardust dispatcher 같은 신뢰된 서비스가 /api/totp/* 등을 호출할 때 사용하는
 * Bearer 토큰 검증. constant-time 비교로 timing leak 방지.
 *
 * 토큰 미설정 (개발/실수) 시 503 — 인증 우회 자동 거부.
 */
export async function requireServiceToken(request: Request, config: RuntimeConfig): Promise<void> {
    const expected = config.dispatcherServiceToken;
    if (!expected) {
        throw error(503, "DISPATCHER_SERVICE_TOKEN 미설정 — service API 비활성");
    }

    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) {
        throw error(401, "Missing or malformed Authorization header (expected: Bearer <token>)");
    }

    const provided = match[1];
    if (!(await timingSafeEqualStr(provided, expected))) {
        throw error(401, "Invalid service token");
    }
}

// ctrls LOW: 원문 문자열을 직접 비교하면 길이 불일치 조기 반환으로 토큰 길이가 타이밍으로
// 누출되고, JS 엔진 문자열 비교의 상수시간성도 보장되지 않는다. 양쪽을 고정 길이 SHA-256
// 다이제스트로 만든 뒤 상수시간 비교한다(길이 무관, 32바이트 고정).
async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
    const enc = new TextEncoder();
    const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
    const ua = new Uint8Array(da);
    const ub = new Uint8Array(db);
    let diff = 0;
    for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
    return diff === 0;
}

import { error } from "@sveltejs/kit";
import type { RuntimeConfig } from "./runtime";

/**
 * stardust dispatcher 같은 신뢰된 서비스가 /api/totp/* 등을 호출할 때 사용하는
 * Bearer 토큰 검증. constant-time 비교로 timing leak 방지.
 *
 * 토큰 미설정 (개발/실수) 시 503 — 인증 우회 자동 거부.
 */
export function requireServiceToken(request: Request, config: RuntimeConfig): void {
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
    if (!timingSafeEqual(provided, expected)) {
        throw error(401, "Invalid service token");
    }
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

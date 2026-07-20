import { error, type RequestEvent } from "@sveltejs/kit";
import { getRequestMetadata, recordAuditEvent } from "$lib/server/audit";
import { checkRateLimit } from "$lib/server/ratelimit";

/**
 * stardust dispatcher 같은 신뢰된 서비스가 /api/totp/* 등을 호출할 때 사용하는
 * Bearer 토큰 검증. constant-time 비교로 timing leak 방지.
 *
 * 토큰 미설정 (개발/실수) 시 503 — 인증 우회 자동 거부.
 *
 * ctrls M-SVC-1: 실패한 인증 시도는 IP 단위로 rate-limit 하고 audit 에 남긴다.
 * 정상 dispatcher 는 항상 올바른 토큰을 보내므로 실패 카운터를 건드리지 않는다 —
 * 오직 무차별 대입(brute-force) 시도만 카운트되어 조용한 온라인 추측을 차단한다.
 */

// 실패 시도 throttle: 5분 창에 IP 당 20회. 정상 트래픽은 실패하지 않으므로 영향 없음.
const SVC_TOKEN_FAIL_WINDOW_MS = 5 * 60 * 1000;
const SVC_TOKEN_FAIL_LIMIT = 20;

export async function requireServiceToken(event: RequestEvent): Promise<void> {
    const expected = event.locals.runtimeConfig.dispatcherServiceToken;
    if (!expected) {
        throw error(503, "DISPATCHER_SERVICE_TOKEN 미설정 — service API 비활성");
    }

    const header = event.request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const ok = match ? await timingSafeEqualStr(match[1], expected) : false;

    if (!ok) {
        // 실패 경로에서만 audit + throttle. throttle 초과 시 429 로 조기 차단한다.
        await recordServiceTokenFailure(event);
        throw error(401, match ? "Invalid service token" : "Missing or malformed Authorization header (expected: Bearer <token>)");
    }
}

/**
 * 서비스 토큰 인증 실패를 audit 에 기록하고 IP 단위 실패 카운터를 증가시킨다.
 * audit 실패는 deny 경로를 막지 않는다(best-effort). throttle 초과 시 429 를 던진다.
 */
async function recordServiceTokenFailure(event: RequestEvent): Promise<void> {
    const meta = getRequestMetadata(event);
    const db = event.locals.db;
    const tenantId = event.locals.tenant?.id ?? null;

    if (db && tenantId) {
        try {
            await recordAuditEvent(db, {
                tenantId,
                kind: "service_token_rejected",
                outcome: "failure",
                ip: meta.ip,
                userAgent: meta.userAgent,
            });
        } catch {
            // audit 실패는 무시 — 인증 거부 자체를 막으면 안 된다.
        }
    }

    const store = event.locals.rateLimitStore;
    if (store) {
        const rl = await checkRateLimit(store, `svc-token-fail:${meta.ipKey}`, { windowMs: SVC_TOKEN_FAIL_WINDOW_MS, limit: SVC_TOKEN_FAIL_LIMIT });
        if (!rl.allowed) {
            throw error(429, "Too many failed service-token attempts");
        }
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

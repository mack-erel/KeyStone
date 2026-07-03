import type { RequestEvent } from "@sveltejs/kit";
import type { DB } from "$lib/server/db";
import { auditEvents } from "$lib/server/db/schema";

export interface AuditEventInput {
    tenantId: string;
    userId?: string | null;
    actorId?: string | null;
    spOrClientId?: string | null;
    kind: string;
    outcome: "success" | "failure";
    ip?: string | null;
    userAgent?: string | null;
    detail?: Record<string, unknown>;
}

// ctrls H-ADMIN-3: X-Forwarded-For fallback 제거.
// Cloudflare Workers 환경에서는 cf-connecting-ip 가 신뢰 가능한 단일 소스이며,
// 외부 요청이 임의로 설정 가능한 X-Forwarded-For 를 fallback 으로 두면 dev
// 환경 또는 잘못된 reverse proxy 구성 하에서 IP 위조로 audit log 오염 / IP 기반
// rate-limit 우회가 가능해진다. dev 환경에서는 IP 가 null 로 기록되며, 이는
// 의도된 동작이다 (운영 = CF 뒤에서 동작).
export function getRequestMetadata(event: RequestEvent) {
    const ip = event.request.headers.get("cf-connecting-ip");

    return {
        ip: ip ?? null,
        // 레이트 리밋 키 전용 정규화 값 — IPv6 는 /64 로 묶어 /128 단위 우회를 막는다.
        // audit 용 ip 는 정밀도 유지를 위해 원본을 그대로 둔다.
        ipKey: normalizeIpForRateLimit(ip),
        userAgent: event.request.headers.get("user-agent"),
    };
}

/**
 * ctrls C6: 레이트 리밋 키에 쓸 IP 를 정규화한다.
 *   - IPv4 / 미상값: 그대로 (null → "unknown")
 *   - IPv6: 상위 64비트(앞 4개 hextet)만 사용 → `<prefix>::/64`.
 *     단일 호스트가 /64 전체를 보유하므로, /128 단위로 키를 바꿔 가며 rate-limit 을
 *     우회하는 것을 차단한다.
 */
export function normalizeIpForRateLimit(ip: string | null | undefined): string {
    const addr = (ip ?? "").trim();
    if (!addr) return "unknown";
    if (!addr.includes(":")) return addr; // IPv4 또는 불투명 토큰

    const bare = addr.replace(/^\[/, "").replace(/\]$/, "").split("%")[0];
    const hasCompaction = bare.includes("::");
    const [headRaw, tailRaw] = hasCompaction ? bare.split("::") : [bare, null];
    const head = headRaw ? headRaw.split(":") : [];
    const tail = tailRaw ? tailRaw.split(":") : [];

    let groups: string[];
    if (hasCompaction) {
        const missing = Math.max(0, 8 - head.length - tail.length);
        groups = [...head, ...Array(missing).fill("0"), ...tail];
    } else {
        groups = head;
    }

    const prefix = groups
        .slice(0, 4)
        .map((g) => (g === "" ? "0" : g.toLowerCase()))
        .join(":");
    return `${prefix}::/64`;
}

export async function recordAuditEvent(db: DB, input: AuditEventInput) {
    await db.insert(auditEvents).values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        actorId: input.actorId ?? null,
        spOrClientId: input.spOrClientId ?? null,
        kind: input.kind,
        outcome: input.outcome,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        detailJson: input.detail ? JSON.stringify(input.detail) : null,
    });
}

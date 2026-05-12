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
        userAgent: event.request.headers.get("user-agent"),
    };
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

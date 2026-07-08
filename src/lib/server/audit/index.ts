import type { RequestEvent } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
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

// ctrls H-ADMIN-3 / H-API-1: 신뢰 가능한 클라이언트 IP 결정.
// Cloudflare Workers 환경에서만 cf-connecting-ip 를 신뢰한다 — 이 헤더는 CF 엣지가
// 설정하며 클라이언트가 위조할 수 없다. Node/기타(adapter-node) 배포에서는 동일
// 헤더를 외부 요청이 임의로 주입할 수 있으므로 절대 신뢰하지 않고, 어댑터가 제공하는
// 실제 소켓 주소(event.getClientAddress())를 사용한다. 이를 신뢰하면 요청마다 IP 를
// 회전시켜 IP 기반 rate-limit 을 우회하고 audit log 에 위조 IP 를 주입할 수 있다.
//
// Workers/Node 판별은 hooks.server.ts 의 GC 스케줄러 분기와 동일한 시그널
// (platform.ctx.waitUntil 존재 여부)을 사용한다.
export function getRequestMetadata(event: RequestEvent) {
    const isWorkers = typeof event.platform?.ctx?.waitUntil === "function";
    let ip: string | null;
    if (isWorkers) {
        ip = event.request.headers.get("cf-connecting-ip");
    } else {
        // adapter-node: 실제 peer 주소. 신뢰된 프록시가 앞단에 있고 forwarded 헤더를
        // 존중해야 한다면 SvelteKit ADDRESS_HEADER 환경변수로 명시적으로 구성해야 한다.
        try {
            ip = event.getClientAddress();
        } catch {
            ip = null;
        }
    }

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

// ctrls H-ADMIN-2: 감사 이벤트 행 단위 무결성.
// 각 행의 안정 필드를 순서 고정 직렬화한 뒤 IDP_SIGNING_KEY_SECRET 으로 HMAC-SHA256 을
// 계산해 저장한다. DB write 권한만으로는 (키가 없으면) 필드 변조/행 위조를 할 수 없다.
// prev-hash 체인이 아니라 행 단위 MAC 이므로 동시 쓰기 fork 문제가 없다. 단, 행 전체
// 삭제는 이 방식으로 탐지되지 않으므로 운영에서는 Logpush 등 외부 미러를 병행 권장한다.
interface AuditRowForHash {
    id: string;
    tenantId: string;
    userId: string | null;
    actorId: string | null;
    spOrClientId: string | null;
    kind: string;
    outcome: string;
    ip: string | null;
    userAgent: string | null;
    detailJson: string | null;
    createdAtMs: number;
}

function canonicalizeAuditRow(row: AuditRowForHash): string {
    // 검증 시 동일 순서로 재계산해야 하므로 필드 순서를 고정한다.
    return JSON.stringify(["audit-v1", row.id, row.tenantId, row.userId, row.actorId, row.spOrClientId, row.kind, row.outcome, row.ip, row.userAgent, row.detailJson, row.createdAtMs]);
}

export async function computeAuditHash(secret: string, row: AuditRowForHash): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(canonicalizeAuditRow(row)));
    const bytes = new Uint8Array(sig);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
}

export async function recordAuditEvent(db: DB, input: AuditEventInput) {
    const id = crypto.randomUUID();
    const createdAt = new Date();
    const detailJson = input.detail ? JSON.stringify(input.detail) : null;

    const row: AuditRowForHash = {
        id,
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        actorId: input.actorId ?? null,
        spOrClientId: input.spOrClientId ?? null,
        kind: input.kind,
        outcome: input.outcome,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        detailJson,
        createdAtMs: createdAt.getTime(),
    };

    // 키 미설정(dev) 시 hash 는 null 로 저장되고 무결성 검증은 비활성 상태가 된다.
    const secret = env.IDP_SIGNING_KEY_SECRET;
    const hash = secret ? await computeAuditHash(secret, row) : null;

    await db.insert(auditEvents).values({
        id,
        tenantId: row.tenantId,
        userId: row.userId,
        actorId: row.actorId,
        spOrClientId: row.spOrClientId,
        kind: row.kind,
        outcome: input.outcome,
        ip: row.ip,
        userAgent: row.userAgent,
        detailJson,
        createdAt,
        hash,
    });
}

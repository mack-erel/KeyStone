import { and, eq } from "drizzle-orm";
import type { DB } from "$lib/server/db";
import { samlSps, samlSessions } from "$lib/server/db/schema";

export type SamlSpRecord = typeof samlSps.$inferSelect;

const SAML_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8시간

/** entityId 비교 전 표준 형태로 정규화. (선후행 공백 제거 + 소문자) */
export function normalizeEntityId(entityId: string): string {
    return entityId.trim().toLowerCase();
}

export async function findSp(db: DB, tenantId: string, entityId: string): Promise<SamlSpRecord | null> {
    const normalized = normalizeEntityId(entityId);
    if (!normalized) return null;
    // DB 의 entityId 는 등록 시 그대로 저장되어 있을 수 있으므로 candidate 들을 모두 LOWER 비교한다.
    const rows = await db
        .select()
        .from(samlSps)
        .where(and(eq(samlSps.tenantId, tenantId), eq(samlSps.enabled, true)));
    return rows.find((r) => normalizeEntityId(r.entityId) === normalized) ?? null;
}

export interface RecordSamlSessionParams {
    tenantId: string;
    spId: string;
    userId: string;
    sessionId: string;
    sessionIndex: string;
    nameId: string;
    nameIdFormat: string;
}

export async function recordSamlSession(db: DB, params: RecordSamlSessionParams): Promise<void> {
    await db.insert(samlSessions).values({
        id: crypto.randomUUID(),
        ...params,
        notOnOrAfter: new Date(Date.now() + SAML_SESSION_TTL_MS),
    });
}

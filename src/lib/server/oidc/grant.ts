import { and, eq, gt, isNull } from "drizzle-orm";
import type { DB } from "$lib/server/db";
import { oidcGrants } from "$lib/server/db/schema";

export type OidcGrantRecord = typeof oidcGrants.$inferSelect;

const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5분

export interface CreateGrantParams {
    tenantId: string;
    clientId: string;
    userId: string;
    sessionId: string;
    code: string;
    codeChallenge: string | null;
    codeChallengeMethod: "S256" | "plain" | null;
    redirectUri: string;
    scope: string;
    nonce: string | null;
    state: string | null;
    acr?: string | null;
}

// ctrls C-6: authorization code 평문 저장 제거. RP 에 전달되는 raw code 의
// SHA-256 해시만 DB 에 보관 → DB read 권한 (replica, 백업, readonly admin) 만으로
// 토큰 교환을 시도할 수 없게 된다.
async function sha256Base64Url(input: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createGrant(db: DB, params: CreateGrantParams): Promise<void> {
    const codeHash = await sha256Base64Url(params.code);
    // code (평문) 컬럼은 legacy 호환을 위해 nullable 로 유지하되, 신규 grant 는
    // null 로 저장한다. 다음 PR 에서 컬럼 자체를 drop.
    const { code: _omit, ...rest } = params;
    void _omit;
    await db.insert(oidcGrants).values({
        id: crypto.randomUUID(),
        ...rest,
        code: null,
        codeHash,
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
    });
}

/**
 * grant 를 원자적으로 조회 + 소진한다.
 * UPDATE ... WHERE usedAt IS NULL RETURNING 으로 경쟁 조건 없이 1회만 사용 가능.
 *
 * 입력 raw code 의 SHA-256 해시로 lookup. legacy grant (codeHash 가 NULL 인 row)
 * 는 새 reader 가 찾지 못하므로 5분 TTL 안에 자연 소멸한다 — 배포 직후 ≤5분간
 * 발급 흐름 중이던 grant 만 영향, 운영 윈도우 안에 정상 회복.
 */
export async function findAndConsumeGrant(db: DB, tenantId: string, clientId: string, code: string): Promise<OidcGrantRecord | null> {
    const now = new Date();
    const codeHash = await sha256Base64Url(code);
    const [grant] = await db
        .update(oidcGrants)
        .set({ usedAt: now })
        .where(and(eq(oidcGrants.codeHash, codeHash), eq(oidcGrants.tenantId, tenantId), eq(oidcGrants.clientId, clientId), isNull(oidcGrants.usedAt), gt(oidcGrants.expiresAt, now)))
        .returning();
    return grant ?? null;
}

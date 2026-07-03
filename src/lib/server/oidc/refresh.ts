/**
 * OIDC Refresh Token 발급·회전.
 *
 * 정책:
 *   - raw 토큰은 저장하지 않고 SHA-256 해시만 DB(`oidc_refresh_tokens`)에 보관 —
 *     DB read 권한만으로는 토큰을 재구성할 수 없다 (authorization code 와 동일 정책).
 *   - 회전(rotation): 사용된 refresh token 은 즉시 revoke 하고 새 토큰을 발급한다.
 *     `revokedAt IS NULL` 가드가 걸린 원자적 UPDATE 로 old 토큰을 claim 하므로
 *     동시 사용은 단 하나만 성공한다.
 *   - 재사용 감지(breach detection): 이미 revoke 된 토큰(또는 동시 사용으로 claim 실패)이
 *     제출되면 해당 (user, client) 의 활성 refresh token 을 전부 폐기한다 (RFC 6819 §5.2.2.3).
 */

import { and, eq, isNull, lt } from "drizzle-orm";
import { type DB, DB_DIALECT } from "$lib/server/db";
import { oidcRefreshTokens } from "$lib/server/db/schema";

export type OidcRefreshTokenRecord = typeof oidcRefreshTokens.$inferSelect;

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일

async function hashRefreshToken(token: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
}

function generateRefreshToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    // URL-safe base64 (RP 가 body 파라미터로 그대로 사용)
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface IssueRefreshTokenParams {
    tenantId: string;
    clientId: string;
    userId: string;
    sessionId: string | null;
    scope: string;
}

/** 새 refresh token 을 발급하고 raw 토큰 문자열을 반환한다. */
export async function issueRefreshToken(db: DB, params: IssueRefreshTokenParams): Promise<string> {
    const token = generateRefreshToken();
    const tokenHash = await hashRefreshToken(token);
    await db.insert(oidcRefreshTokens).values({
        id: crypto.randomUUID(),
        tenantId: params.tenantId,
        clientId: params.clientId,
        userId: params.userId,
        sessionId: params.sessionId,
        tokenHash,
        scope: params.scope,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });
    return token;
}

/** (user, client) 의 활성 refresh token 을 전부 폐기 (재사용/침해 감지, 세션 만료 시). */
export async function revokeRefreshTokenFamily(db: DB, tenantId: string, userId: string, clientId: string): Promise<void> {
    await db
        .update(oidcRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(oidcRefreshTokens.tenantId, tenantId), eq(oidcRefreshTokens.userId, userId), eq(oidcRefreshTokens.clientId, clientId), isNull(oidcRefreshTokens.revokedAt)));
}

/** 특정 IdP 세션에 묶인 활성 refresh token 을 전부 폐기 (로그아웃 시). */
export async function revokeRefreshTokensForSession(db: DB, sessionId: string): Promise<void> {
    await db
        .update(oidcRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(oidcRefreshTokens.sessionId, sessionId), isNull(oidcRefreshTokens.revokedAt)));
}

/** 사용자의 활성 refresh token 을 전부 폐기 (비밀번호 재설정·권한 변경 등 전역 무효화 시). */
export async function revokeAllUserRefreshTokens(db: DB, userId: string): Promise<void> {
    await db
        .update(oidcRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(oidcRefreshTokens.userId, userId), isNull(oidcRefreshTokens.revokedAt)));
}

export type RotateResult = { ok: true; record: OidcRefreshTokenRecord; newToken: string } | { ok: false; reason: "invalid_grant" | "expired" | "reuse" };

/**
 * 제출된 refresh token 을 검증하고 회전한다.
 * 성공 시 old 토큰을 revoke(+replacedById) 하고 새 raw 토큰과 원본 레코드를 반환한다.
 */
export async function rotateRefreshToken(db: DB, tenantId: string, clientId: string, presentedToken: string): Promise<RotateResult> {
    const tokenHash = await hashRefreshToken(presentedToken);
    const [record] = await db
        .select()
        .from(oidcRefreshTokens)
        .where(and(eq(oidcRefreshTokens.tokenHash, tokenHash), eq(oidcRefreshTokens.tenantId, tenantId), eq(oidcRefreshTokens.clientId, clientId)))
        .limit(1);

    if (!record) return { ok: false, reason: "invalid_grant" };

    // 이미 revoke 된 토큰의 재사용 → 침해 가능성. family 전체 폐기 후 거부.
    if (record.revokedAt) {
        await revokeRefreshTokenFamily(db, tenantId, record.userId, clientId);
        return { ok: false, reason: "reuse" };
    }
    if (record.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };

    const now = new Date();
    const newId = crypto.randomUUID();
    const newToken = generateRefreshToken();
    const newHash = await hashRefreshToken(newToken);

    // old 토큰을 원자적으로 claim (revokedAt IS NULL 가드). 동시 사용은 하나만 성공.
    const claimWhere = and(eq(oidcRefreshTokens.id, record.id), isNull(oidcRefreshTokens.revokedAt));
    let claimed: boolean;
    if (DB_DIALECT === "mysql") {
        const res = (await db.update(oidcRefreshTokens).set({ revokedAt: now, replacedById: newId }).where(claimWhere)) as unknown as [{ affectedRows: number }];
        claimed = Boolean(res?.[0]?.affectedRows);
    } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const updateBuilder = db.update(oidcRefreshTokens).set({ revokedAt: now, replacedById: newId }).where(claimWhere) as any;
        const rows = (await updateBuilder.returning({ id: oidcRefreshTokens.id })) as Array<{ id: string }>;
        claimed = rows.length > 0;
    }

    if (!claimed) {
        // 이미 다른 요청이 회전 → 동시 재사용으로 간주하고 family 폐기.
        await revokeRefreshTokenFamily(db, tenantId, record.userId, clientId);
        return { ok: false, reason: "reuse" };
    }

    await db.insert(oidcRefreshTokens).values({
        id: newId,
        tenantId,
        clientId,
        userId: record.userId,
        sessionId: record.sessionId,
        tokenHash: newHash,
        scope: record.scope,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });

    return { ok: true, record, newToken };
}

/** 만료된 refresh token 레코드를 정리 (주기적 호출용). */
export async function purgeExpiredRefreshTokens(db: DB): Promise<void> {
    await db.delete(oidcRefreshTokens).where(lt(oidcRefreshTokens.expiresAt, new Date()));
}

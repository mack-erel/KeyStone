import { and, eq, gt, isNull, ne } from "drizzle-orm";
import type { Cookies } from "@sveltejs/kit";
import type { DB } from "$lib/server/db";
import { sessions, users } from "$lib/server/db/schema";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from "./constants";

function bytesToBase64Url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

async function hashSessionToken(token: string): Promise<string> {
    const data = new TextEncoder().encode(token);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return bytesToBase64Url(new Uint8Array(hash));
}

function cookieOptions(url: URL, expiresAt: Date) {
    return {
        path: "/",
        httpOnly: true,
        sameSite: "lax" as const,
        secure: url.protocol === "https:",
        expires: expiresAt,
    };
}

export function createSessionToken(): string {
    return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createSessionRecord(
    db: DB,
    params: {
        tenantId: string;
        userId: string;
        ip?: string | null;
        userAgent?: string | null;
        /** Authentication Methods References (RFC 8176), e.g. ['pwd'], ['pwd','totp'] */
        amr?: string[];
        /** Authentication Context Class Reference */
        acr?: string;
    },
) {
    const now = Date.now();
    const expiresAt = new Date(now + SESSION_TTL_MS);
    const sessionToken = createSessionToken();

    const tokenHash = await hashSessionToken(sessionToken);
    const sessionId = crypto.randomUUID();

    await db.insert(sessions).values({
        id: sessionId,
        tenantId: params.tenantId,
        userId: params.userId,
        idpSessionId: tokenHash,
        amr: params.amr ? params.amr.join(" ") : null,
        acr: params.acr ?? null,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        expiresAt,
        lastSeenAt: new Date(now),
    });

    return { sessionToken, expiresAt, sessionId };
}

/**
 * 새로 발급된 세션을 제외한 동일 사용자의 모든 활성 세션을 무효화한다.
 * 로그인/MFA/패스키 인증 직후 호출하면 기존 세션 탈취 흔적을 제거할 수 있다.
 */
export async function revokeOtherSessions(db: DB, userId: string, keepSessionId: string, revokedAt = new Date()) {
    await db
        .update(sessions)
        .set({ revokedAt })
        .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId), isNull(sessions.revokedAt)));
}

export async function getSessionContext(db: DB, sessionToken: string) {
    const now = new Date();
    const tokenHash = await hashSessionToken(sessionToken);
    const [row] = await db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(and(eq(sessions.idpSessionId, tokenHash), gt(sessions.expiresAt, now), isNull(sessions.revokedAt), eq(users.status, "active")))
        .limit(1);

    return row ?? null;
}

export async function touchSession(db: DB, sessionId: string, timestamp = new Date()) {
    await db.update(sessions).set({ lastSeenAt: timestamp }).where(eq(sessions.id, sessionId));
}

export async function revokeSession(db: DB, sessionToken: string, revokedAt = new Date()) {
    await db
        .update(sessions)
        .set({ revokedAt })
        .where(and(eq(sessions.idpSessionId, sessionToken), isNull(sessions.revokedAt)));
}

export async function revokeAllUserSessions(db: DB, userId: string, revokedAt = new Date()) {
    await db
        .update(sessions)
        .set({ revokedAt })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export function setSessionCookie(cookies: Cookies, url: URL, sessionToken: string, expiresAt: Date) {
    cookies.set(SESSION_COOKIE_NAME, sessionToken, cookieOptions(url, expiresAt));
}

export function clearSessionCookie(cookies: Cookies, url: URL) {
    cookies.delete(SESSION_COOKIE_NAME, cookieOptions(url, new Date(0)));
}

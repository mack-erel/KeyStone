import { and, eq, gt, isNull } from "drizzle-orm";
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

    await db.insert(sessions).values({
        id: crypto.randomUUID(),
        tenantId: params.tenantId,
        userId: params.userId,
        idpSessionId: sessionToken,
        amr: params.amr ? params.amr.join(" ") : null,
        acr: params.acr ?? null,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        expiresAt,
        lastSeenAt: new Date(now),
    });

    return { sessionToken, expiresAt };
}

export async function getSessionContext(db: DB, sessionToken: string) {
    const now = new Date();
    const [row] = await db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(and(eq(sessions.idpSessionId, sessionToken), gt(sessions.expiresAt, now), isNull(sessions.revokedAt), eq(users.status, "active")))
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

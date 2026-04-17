import { and, eq } from "drizzle-orm";
import type { DB } from "$lib/server/db";
import { credentials, type Credential, type User, users } from "$lib/server/db/schema";
import { PASSWORD_CREDENTIAL_TYPE, TOTP_CREDENTIAL_TYPE } from "./constants";
import { verifyPassword } from "./password";

export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export function normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
}

export async function findUserByEmail(db: DB, tenantId: string, email: string): Promise<User | null> {
    const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.email, normalizeEmail(email))))
        .limit(1);

    return user ?? null;
}

export async function findUserByUsername(db: DB, tenantId: string, username: string): Promise<User | null> {
    const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.username, normalizeUsername(username))))
        .limit(1);

    return user ?? null;
}

export async function findPasswordCredential(db: DB, userId: string): Promise<Credential | null> {
    const [credential] = await db
        .select()
        .from(credentials)
        .where(and(eq(credentials.userId, userId), eq(credentials.type, PASSWORD_CREDENTIAL_TYPE)))
        .limit(1);

    return credential ?? null;
}

export async function authenticateLocalUser(db: DB, tenantId: string, username: string, password: string): Promise<User | null> {
    const user = await findUserByUsername(db, tenantId, username);

    if (!user || user.status !== "active") {
        return null;
    }

    const credential = await findPasswordCredential(db, user.id);

    if (!credential?.secret) {
        return null;
    }

    const result = await verifyPassword(password, credential.secret);

    if (!result.valid) {
        return null;
    }

    if (result.rehash) {
        await db.update(credentials).set({ secret: result.rehash, lastUsedAt: new Date() }).where(eq(credentials.id, credential.id));
    }

    return user;
}

export async function findActiveUserById(db: DB, userId: string): Promise<User | null> {
    const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, userId), eq(users.status, "active")))
        .limit(1);
    return user ?? null;
}

export async function hasTotpCredential(db: DB, userId: string): Promise<boolean> {
    const [row] = await db
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.userId, userId), eq(credentials.type, TOTP_CREDENTIAL_TYPE)))
        .limit(1);
    return Boolean(row);
}

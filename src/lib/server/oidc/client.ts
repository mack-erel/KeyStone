import { and, eq } from "drizzle-orm";
import type { DB } from "$lib/server/db";
import { oidcClients } from "$lib/server/db/schema";
import { verifyPassword } from "$lib/server/auth/password";

export type OidcClientRecord = typeof oidcClients.$inferSelect;

export async function findOidcClient(db: DB, tenantId: string, clientId: string): Promise<OidcClientRecord | null> {
    const [client] = await db
        .select()
        .from(oidcClients)
        .where(and(eq(oidcClients.tenantId, tenantId), eq(oidcClients.clientId, clientId), eq(oidcClients.enabled, true)))
        .limit(1);
    return client ?? null;
}

export function parseBasicAuth(authHeader: string): { clientId: string; clientSecret: string } | null {
    if (!authHeader.startsWith("Basic ")) return null;
    const decoded = atob(authHeader.slice(6));
    const sep = decoded.indexOf(":");
    try {
        return {
            clientId: decodeURIComponent(sep > -1 ? decoded.slice(0, sep) : decoded),
            clientSecret: decodeURIComponent(sep > -1 ? decoded.slice(sep + 1) : ""),
        };
    } catch {
        return null;
    }
}

export async function isValidClientSecret(client: OidcClientRecord, clientSecret: string): Promise<boolean> {
    if (client.tokenEndpointAuthMethod === "none") return true;
    if (!client.clientSecretHash || !clientSecret) return false;
    const result = await verifyPassword(clientSecret, client.clientSecretHash);
    return result.valid;
}

export function parseRedirectUris(client: OidcClientRecord): string[] {
    try {
        return JSON.parse(client.redirectUris ?? "[]") as string[];
    } catch {
        return [];
    }
}

export function isAllowedRedirectUri(client: OidcClientRecord, redirectUri: string): boolean {
    return parseRedirectUris(client).includes(redirectUri);
}

export function parseGrantedScopes(client: OidcClientRecord, requestedScope: string): string[] {
    // RFC 6749: scope 토큰은 SP(공백) 으로만 구분된다. 콤마 등은 허용하지 않는다.
    const allowedScopes = client.scopes
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
    return requestedScope
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && allowedScopes.includes(s));
}

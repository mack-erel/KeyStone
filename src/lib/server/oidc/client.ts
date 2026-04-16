import { and, eq } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { oidcClients } from '$lib/server/db/schema';

export type OidcClientRecord = typeof oidcClients.$inferSelect;

export async function findOidcClient(
	db: DB,
	tenantId: string,
	clientId: string
): Promise<OidcClientRecord | null> {
	const [client] = await db
		.select()
		.from(oidcClients)
		.where(
			and(
				eq(oidcClients.tenantId, tenantId),
				eq(oidcClients.clientId, clientId),
				eq(oidcClients.enabled, true)
			)
		)
		.limit(1);
	return client ?? null;
}

export function parseBasicAuth(
	authHeader: string
): { clientId: string; clientSecret: string } | null {
	if (!authHeader.startsWith('Basic ')) return null;
	const decoded = atob(authHeader.slice(6));
	const sep = decoded.indexOf(':');
	return {
		clientId: sep > -1 ? decoded.slice(0, sep) : decoded,
		clientSecret: sep > -1 ? decoded.slice(sep + 1) : ''
	};
}

/** M1: 평문 비교 — M2 에서 해시 비교로 전환 예정 */
export function isValidClientSecret(client: OidcClientRecord, clientSecret: string): boolean {
	if (client.tokenEndpointAuthMethod === 'none') return true;
	return Boolean(
		client.clientSecretHash && clientSecret && clientSecret === client.clientSecretHash
	);
}

export function parseRedirectUris(client: OidcClientRecord): string[] {
	try {
		return JSON.parse(client.redirectUris ?? '[]') as string[];
	} catch {
		return [];
	}
}

export function isAllowedRedirectUri(client: OidcClientRecord, redirectUri: string): boolean {
	return parseRedirectUris(client).includes(redirectUri);
}

export function parseGrantedScopes(client: OidcClientRecord, requestedScope: string): string[] {
	const allowedScopes = client.scopes
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	return requestedScope.split(/[\s,]+/).filter((s) => allowedScopes.includes(s));
}

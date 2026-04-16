import { and, eq, gt, isNull } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { oidcGrants } from '$lib/server/db/schema';

export type OidcGrantRecord = typeof oidcGrants.$inferSelect;

const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5분

export interface CreateGrantParams {
	tenantId: string;
	clientId: string;
	userId: string;
	sessionId: string;
	code: string;
	codeChallenge: string | null;
	codeChallengeMethod: 'S256' | 'plain' | null;
	redirectUri: string;
	scope: string;
	nonce: string | null;
	state: string | null;
}

export async function createGrant(db: DB, params: CreateGrantParams): Promise<void> {
	await db.insert(oidcGrants).values({
		id: crypto.randomUUID(),
		...params,
		expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS)
	});
}

export async function findGrant(
	db: DB,
	tenantId: string,
	clientId: string,
	code: string
): Promise<OidcGrantRecord | null> {
	const now = new Date();
	const [grant] = await db
		.select()
		.from(oidcGrants)
		.where(
			and(
				eq(oidcGrants.code, code),
				eq(oidcGrants.tenantId, tenantId),
				eq(oidcGrants.clientId, clientId),
				isNull(oidcGrants.usedAt),
				gt(oidcGrants.expiresAt, now)
			)
		)
		.limit(1);
	return grant ?? null;
}

export async function consumeGrant(db: DB, grantId: string): Promise<void> {
	await db.update(oidcGrants).set({ usedAt: new Date() }).where(eq(oidcGrants.id, grantId));
}

import { and, eq } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { samlSps, samlSessions } from '$lib/server/db/schema';

export type SamlSpRecord = typeof samlSps.$inferSelect;

const SAML_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8시간

export async function findSp(
	db: DB,
	tenantId: string,
	entityId: string
): Promise<SamlSpRecord | null> {
	const [sp] = await db
		.select()
		.from(samlSps)
		.where(
			and(eq(samlSps.tenantId, tenantId), eq(samlSps.entityId, entityId), eq(samlSps.enabled, true))
		)
		.limit(1);
	return sp ?? null;
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
		notOnOrAfter: new Date(Date.now() + SAML_SESSION_TTL_MS)
	});
}

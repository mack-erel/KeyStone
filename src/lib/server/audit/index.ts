import type { RequestEvent } from '@sveltejs/kit';
import type { DB } from '$lib/server/db';
import { auditEvents } from '$lib/server/db/schema';

export interface AuditEventInput {
	tenantId: string;
	userId?: string | null;
	actorId?: string | null;
	spOrClientId?: string | null;
	kind: string;
	outcome: 'success' | 'failure';
	ip?: string | null;
	userAgent?: string | null;
	detail?: Record<string, unknown>;
}

export function getRequestMetadata(event: RequestEvent) {
	const forwardedFor = event.request.headers.get('x-forwarded-for');
	const ip =
		event.request.headers.get('cf-connecting-ip') ?? forwardedFor?.split(',')[0]?.trim() ?? null;

	return {
		ip,
		userAgent: event.request.headers.get('user-agent')
	};
}

export async function recordAuditEvent(db: DB, input: AuditEventInput) {
	await db.insert(auditEvents).values({
		id: crypto.randomUUID(),
		tenantId: input.tenantId,
		userId: input.userId ?? null,
		actorId: input.actorId ?? null,
		spOrClientId: input.spOrClientId ?? null,
		kind: input.kind,
		outcome: input.outcome,
		ip: input.ip ?? null,
		userAgent: input.userAgent ?? null,
		detailJson: input.detail ? JSON.stringify(input.detail) : null
	});
}

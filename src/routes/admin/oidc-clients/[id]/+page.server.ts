import { error, fail } from "@sveltejs/kit";
import { and, asc, eq } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireAdminContext } from "$lib/server/auth/guards";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import type { DB } from "$lib/server/db";
import { oidcClients, serviceRoles } from "$lib/server/db/schema";

const ROLE_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export const load: PageServerLoad = async ({ locals, params }) => {
    const { db, tenant } = requireAdminContext(locals);

    const [client] = await db
        .select()
        .from(oidcClients)
        .where(and(eq(oidcClients.id, params.id), eq(oidcClients.tenantId, tenant.id)))
        .limit(1);
    if (!client) error(404, "클라이언트를 찾을 수 없습니다.");

    const roles = await db
        .select()
        .from(serviceRoles)
        .where(and(eq(serviceRoles.tenantId, tenant.id), eq(serviceRoles.serviceType, "oidc"), eq(serviceRoles.serviceRefId, client.id)))
        .orderBy(asc(serviceRoles.displayOrder), asc(serviceRoles.key));

    return { client, roles };
};

async function clientForTenant(db: DB, tenantId: string, clientDbId: string) {
    const [c] = await db
        .select({ id: oidcClients.id })
        .from(oidcClients)
        .where(and(eq(oidcClients.id, clientDbId), eq(oidcClients.tenantId, tenantId)))
        .limit(1);
    return c ?? null;
}

export const actions: Actions = {
    addRole: async (event) => {
        const { locals, params } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await event.request.formData();

        const key = String(fd.get("key") ?? "").trim();
        const label = String(fd.get("label") ?? "").trim();
        const description = String(fd.get("description") ?? "").trim() || null;
        const isDefault = fd.get("isDefault") === "true";
        const displayOrder = Number(fd.get("displayOrder") ?? "0") | 0;

        if (!ROLE_KEY_RE.test(key)) return fail(400, { error: "key 는 영숫자/._- 만 허용 (1~64자)." });
        if (!label) return fail(400, { error: "label 은 필수입니다." });

        const c = await clientForTenant(db, tenant.id, params.id);
        if (!c) return fail(404, { error: "클라이언트를 찾을 수 없습니다." });

        try {
            await db.insert(serviceRoles).values({
                id: crypto.randomUUID(),
                tenantId: tenant.id,
                serviceType: "oidc",
                serviceRefId: c.id,
                key,
                label,
                description,
                isDefault,
                displayOrder,
            });
        } catch {
            // unique (serviceType, serviceRefId, key)
            return fail(409, { error: "이미 존재하는 role key 입니다." });
        }

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            spOrClientId: params.id,
            kind: "service_role_created",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { serviceType: "oidc", serviceRefId: c.id, key },
        });

        return { added: true };
    },

    updateRole: async (event) => {
        const { locals, params } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await event.request.formData();

        const id = String(fd.get("roleId") ?? "");
        const label = String(fd.get("label") ?? "").trim();
        const description = String(fd.get("description") ?? "").trim() || null;
        const isDefault = fd.get("isDefault") === "true";
        const displayOrder = Number(fd.get("displayOrder") ?? "0") | 0;

        if (!id || !label) return fail(400, { error: "필수 항목 누락." });

        await db
            .update(serviceRoles)
            .set({ label, description, isDefault, displayOrder, updatedAt: new Date() })
            .where(and(eq(serviceRoles.id, id), eq(serviceRoles.tenantId, tenant.id), eq(serviceRoles.serviceType, "oidc"), eq(serviceRoles.serviceRefId, params.id)));

        return { updated: true };
    },

    deleteRole: async (event) => {
        const { locals, params } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await event.request.formData();
        const id = String(fd.get("roleId") ?? "");
        if (!id) return fail(400, { error: "잘못된 요청." });

        await db.delete(serviceRoles).where(and(eq(serviceRoles.id, id), eq(serviceRoles.tenantId, tenant.id), eq(serviceRoles.serviceType, "oidc"), eq(serviceRoles.serviceRefId, params.id)));

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            spOrClientId: params.id,
            kind: "service_role_deleted",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { serviceType: "oidc", serviceRefId: params.id, roleId: id },
        });

        return { deleted: true };
    },
};

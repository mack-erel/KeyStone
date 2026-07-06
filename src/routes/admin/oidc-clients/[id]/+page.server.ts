import { error, fail } from "@sveltejs/kit";
import { and, asc, eq } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireAdminContext } from "$lib/server/auth/guards";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import type { DB } from "$lib/server/db";
import { oidcClients, serviceRoles } from "$lib/server/db/schema";
import { adminError, requireFormId } from "$lib/server/admin/errors";
import { ORGANIZATION_CLAIM_FIELDS, type OrganizationClaimConfig } from "$lib/server/oidc/claims";

const ROLE_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export const load: PageServerLoad = async ({ locals, params }) => {
    const { db, tenant } = requireAdminContext(locals);

    const [client] = await db
        .select()
        .from(oidcClients)
        .where(and(eq(oidcClients.id, params.id), eq(oidcClients.tenantId, tenant.id)))
        .limit(1);
    if (!client) error(404, adminError(locals.locale, "client_not_found"));

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
        const locale = locals.locale;
        const fd = await event.request.formData();

        const key = String(fd.get("key") ?? "").trim();
        const label = String(fd.get("label") ?? "").trim();
        const description = String(fd.get("description") ?? "").trim() || null;
        const isDefault = fd.get("isDefault") === "true";
        const displayOrder = Number(fd.get("displayOrder") ?? "0") | 0;

        if (!ROLE_KEY_RE.test(key)) return fail(400, { error: adminError(locale, "invalid_role_key") });
        if (!label) return fail(400, { error: adminError(locale, "label_required") });

        const c = await clientForTenant(db, tenant.id, params.id);
        if (!c) return fail(404, { error: adminError(locale, "client_not_found") });

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
            return fail(409, { error: adminError(locale, "role_key_exists") });
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
        const locale = locals.locale;
        const fd = await event.request.formData();

        const id = String(fd.get("roleId") ?? "");
        const label = String(fd.get("label") ?? "").trim();
        const description = String(fd.get("description") ?? "").trim() || null;
        const isDefault = fd.get("isDefault") === "true";
        const displayOrder = Number(fd.get("displayOrder") ?? "0") | 0;

        if (!id || !label) return fail(400, { error: adminError(locale, "required_field_missing") });

        await db
            .update(serviceRoles)
            .set({ label, description, isDefault, displayOrder, updatedAt: new Date() })
            .where(and(eq(serviceRoles.id, id), eq(serviceRoles.tenantId, tenant.id), eq(serviceRoles.serviceType, "oidc"), eq(serviceRoles.serviceRefId, params.id)));

        return { updated: true };
    },

    // organization scope 클레임의 클라이언트별 노출 토글 저장.
    // 네 필드가 모두 켜져 있으면 null(=미설정=전량 노출, 하위호환)로 저장해 DB 를 깨끗이 유지하고,
    // 하나라도 꺼져 있으면 명시적 JSON config 를 저장한다. token/userinfo 양쪽이 동일 config 를 적용한다.
    updateOrganizationClaims: async (event) => {
        const { locals, params } = event;
        const { db, tenant } = requireAdminContext(locals);
        const locale = locals.locale;
        const fd = await event.request.formData();

        const c = await clientForTenant(db, tenant.id, params.id);
        if (!c) return fail(404, { error: adminError(locale, "client_not_found") });

        const config: OrganizationClaimConfig = {};
        let allEnabled = true;
        for (const field of ORGANIZATION_CLAIM_FIELDS) {
            const enabled = fd.get(field) === "true";
            config[field] = enabled;
            if (!enabled) allEnabled = false;
        }

        const value = allEnabled ? null : JSON.stringify(config);
        await db
            .update(oidcClients)
            .set({ organizationClaimConfig: value, updatedAt: new Date() })
            .where(and(eq(oidcClients.id, c.id), eq(oidcClients.tenantId, tenant.id)));

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            spOrClientId: params.id,
            kind: "oidc_client_updated",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { organizationClaimConfig: value },
        });

        return { organizationClaimsUpdated: true };
    },

    deleteRole: async (event) => {
        const { locals, params } = event;
        const { db, tenant } = requireAdminContext(locals);
        const locale = locals.locale;
        const fd = await event.request.formData();
        const idr = requireFormId(fd, locale, { field: "roleId" });
        if (!idr.ok) return idr.failure;
        const id = idr.id;

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

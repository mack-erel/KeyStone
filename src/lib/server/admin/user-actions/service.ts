import { fail } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { requireAdminContext, assertUserInTenant } from "$lib/server/auth/guards";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import { oidcClients, samlSps, serviceRoles, userServiceAssignments } from "$lib/server/db/schema";
import { adminError, requireFormId } from "$lib/server/admin/errors";

// 사용자 상세 페이지의 서비스 권한(assignment) 액션.
type UserActionEvent = RequestEvent<{ id: string }, "/admin/users/[id]">;

// ── 서비스 권한 부여 ──────────────────────────────────────────────────────
export async function addAssignment(event: UserActionEvent) {
    const { locals, params, request } = event;
    const { db, tenant } = requireAdminContext(locals);
    const locale = locals.locale;
    const fd = await request.formData();
    const userId = params.id;

    // ctrls C-13: 다른 tenant 의 userId 가 본 tenant 의 권한 row 로 박혀 들어가는
    // cross-tenant IDOR 차단. 기존엔 service ref 만 tenant 검증하고 userId 는
    // 검증 없이 INSERT 했음.
    const tenantCheck = await assertUserInTenant(db, tenant.id, userId);
    if (!tenantCheck.ok) return tenantCheck.error;

    // form 의 service 필드는 "oidc:<id>" 또는 "saml:<id>" 형태.
    const serviceRaw = String(fd.get("service") ?? "");
    const colonIdx = serviceRaw.indexOf(":");
    if (colonIdx <= 0) return fail(400, { error: adminError(locale, "select_service") });
    const serviceType = serviceRaw.slice(0, colonIdx);
    const serviceRefId = serviceRaw.slice(colonIdx + 1);
    if (serviceType !== "oidc" && serviceType !== "saml") return fail(400, { error: adminError(locale, "invalid_service_type") });
    if (!serviceRefId) return fail(400, { error: adminError(locale, "invalid_service_id") });

    const serviceRoleIdRaw = String(fd.get("serviceRoleId") ?? "").trim();
    const serviceRoleId = serviceRoleIdRaw || null;
    const expiresAtRaw = String(fd.get("expiresAt") ?? "").trim();
    const attributesJsonRaw = String(fd.get("attributesJson") ?? "").trim();

    // service ref 가 우리 테넌트의 활성 서비스인지 검증
    if (serviceType === "oidc") {
        const [c] = await db
            .select({ id: oidcClients.id })
            .from(oidcClients)
            .where(and(eq(oidcClients.id, serviceRefId), eq(oidcClients.tenantId, tenant.id)))
            .limit(1);
        if (!c) return fail(404, { error: adminError(locale, "oidc_client_not_found") });
    } else {
        const [s] = await db
            .select({ id: samlSps.id })
            .from(samlSps)
            .where(and(eq(samlSps.id, serviceRefId), eq(samlSps.tenantId, tenant.id)))
            .limit(1);
        if (!s) return fail(404, { error: adminError(locale, "saml_sp_not_found") });
    }

    // role 이 지정됐다면, 같은 service 의 role 인지 검증
    if (serviceRoleId) {
        const [r] = await db
            .select({ id: serviceRoles.id })
            .from(serviceRoles)
            .where(and(eq(serviceRoles.id, serviceRoleId), eq(serviceRoles.tenantId, tenant.id), eq(serviceRoles.serviceType, serviceType), eq(serviceRoles.serviceRefId, serviceRefId)))
            .limit(1);
        if (!r) return fail(400, { error: adminError(locale, "role_not_in_service") });
    }

    let expiresAt: Date | null = null;
    if (expiresAtRaw) {
        const d = new Date(expiresAtRaw);
        if (Number.isNaN(d.getTime())) return fail(400, { error: adminError(locale, "invalid_expiry_format") });
        expiresAt = d;
    }

    let attributesJson: string | null = null;
    if (attributesJsonRaw) {
        try {
            const parsed = JSON.parse(attributesJsonRaw) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                return fail(400, { error: adminError(locale, "attributes_not_object") });
            }
            attributesJson = JSON.stringify(parsed);
        } catch {
            return fail(400, { error: adminError(locale, "attributes_parse_failed") });
        }
    }

    try {
        await db.insert(userServiceAssignments).values({
            id: crypto.randomUUID(),
            tenantId: tenant.id,
            userId,
            serviceType,
            serviceRefId,
            serviceRoleId,
            attributesJson,
            grantedBy: locals.user!.id,
            expiresAt,
        });
    } catch {
        // unique (tenantId, userId, serviceType, serviceRefId)
        return fail(409, { error: adminError(locale, "assignment_exists") });
    }

    const meta = getRequestMetadata(event);
    await recordAuditEvent(db, {
        tenantId: tenant.id,
        userId,
        actorId: locals.user!.id,
        spOrClientId: serviceRefId,
        kind: "service_assignment_granted",
        outcome: "success",
        ip: meta.ip,
        userAgent: meta.userAgent,
        detail: { serviceType, serviceRefId, serviceRoleId, expiresAt },
    });

    return { addedAssignment: true };
}

export async function revokeAssignment(event: UserActionEvent) {
    const { locals, params, request } = event;
    const { db, tenant } = requireAdminContext(locals);
    const fd = await request.formData();
    const idr = requireFormId(fd, locals.locale, { field: "assignmentId" });
    if (!idr.ok) return idr.failure;
    const assignmentId = idr.id;

    // IDOR 가드: 본 페이지 user 의 assignment 만 영향
    await db.delete(userServiceAssignments).where(and(eq(userServiceAssignments.id, assignmentId), eq(userServiceAssignments.userId, params.id), eq(userServiceAssignments.tenantId, tenant.id)));

    const meta = getRequestMetadata(event);
    await recordAuditEvent(db, {
        tenantId: tenant.id,
        userId: params.id,
        actorId: locals.user!.id,
        kind: "service_assignment_revoked",
        outcome: "success",
        ip: meta.ip,
        userAgent: meta.userAgent,
        detail: { assignmentId },
    });

    return { revokedAssignment: true };
}

export async function updateAssignmentExpiry(event: UserActionEvent) {
    const { locals, params, request } = event;
    const { db, tenant } = requireAdminContext(locals);
    const locale = locals.locale;
    const fd = await request.formData();
    const idr = requireFormId(fd, locale, { field: "assignmentId" });
    if (!idr.ok) return idr.failure;
    const assignmentId = idr.id;

    const expiresAtRaw = String(fd.get("expiresAt") ?? "").trim();
    let expiresAt: Date | null = null;
    if (expiresAtRaw) {
        const d = new Date(expiresAtRaw);
        if (Number.isNaN(d.getTime())) return fail(400, { error: adminError(locale, "invalid_expiry_format") });
        expiresAt = d;
    }

    await db
        .update(userServiceAssignments)
        .set({ expiresAt })
        .where(and(eq(userServiceAssignments.id, assignmentId), eq(userServiceAssignments.userId, params.id), eq(userServiceAssignments.tenantId, tenant.id)));

    return { updatedExpiry: true };
}

import { fail } from "@sveltejs/kit";
import { desc, eq, and } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireAdminContext } from "$lib/server/auth/guards";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import { samlSps } from "$lib/server/db/schema";

export const load: PageServerLoad = async ({ locals }) => {
    const { db, tenant } = requireAdminContext(locals);
    const rows = await db
        .select({
            id: samlSps.id,
            entityId: samlSps.entityId,
            name: samlSps.name,
            acsUrl: samlSps.acsUrl,
            acsBinding: samlSps.acsBinding,
            sloUrl: samlSps.sloUrl,
            cert: samlSps.cert,
            nameIdFormat: samlSps.nameIdFormat,
            signAssertion: samlSps.signAssertion,
            signResponse: samlSps.signResponse,
            encryptAssertion: samlSps.encryptAssertion,
            wantAuthnRequestsSigned: samlSps.wantAuthnRequestsSigned,
            allowedAttributes: samlSps.allowedAttributes,
            enabled: samlSps.enabled,
            createdAt: samlSps.createdAt,
        })
        .from(samlSps)
        .where(eq(samlSps.tenantId, tenant.id))
        .orderBy(desc(samlSps.createdAt));

    return { sps: rows };
};

const ATTRIBUTE_KEYS = ["email", "username", "displayName", "givenName", "familyName", "surName", "phoneNumber", "department", "team", "jobTitle", "position"] as const;

function parseAllowedAttributes(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parts = trimmed
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .filter((s): s is (typeof ATTRIBUTE_KEYS)[number] => (ATTRIBUTE_KEYS as readonly string[]).includes(s));
    if (parts.length === 0) return null;
    return JSON.stringify([...new Set(parts)]);
}

export const actions: Actions = {
    // ── SP 생성 ────────────────────────────────────────────────────────────────
    create: async (event) => {
        const { locals } = event;
        const { db, tenant } = requireAdminContext(locals);

        const fd = await event.request.formData();
        const name = String(fd.get("name") ?? "").trim();
        const entityId = String(fd.get("entityId") ?? "").trim();
        const acsUrl = String(fd.get("acsUrl") ?? "").trim();
        const sloUrl = String(fd.get("sloUrl") ?? "").trim();
        const nameIdFormat = String(fd.get("nameIdFormat") ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress").trim();
        const cert = String(fd.get("cert") ?? "").trim();
        const signAssertion = fd.get("signAssertion") === "true";
        const signResponse = fd.get("signResponse") === "true";
        const wantAuthnRequestsSigned = fd.get("wantAuthnRequestsSigned") === "true";
        const allowedAttributes = parseAllowedAttributes(String(fd.get("allowedAttributes") ?? ""));

        if (!name) return fail(400, { create: true, error: "이름은 필수입니다." });
        if (!entityId) return fail(400, { create: true, error: "Entity ID 는 필수입니다." });
        if (!acsUrl) return fail(400, { create: true, error: "ACS URL 은 필수입니다." });

        // 중복 Entity ID 확인
        const [existing] = await db
            .select({ id: samlSps.id })
            .from(samlSps)
            .where(and(eq(samlSps.tenantId, tenant.id), eq(samlSps.entityId, entityId)))
            .limit(1);
        if (existing) return fail(409, { create: true, error: "이미 등록된 Entity ID 입니다." });

        await db.insert(samlSps).values({
            id: crypto.randomUUID(),
            tenantId: tenant.id,
            name,
            entityId,
            acsUrl,
            sloUrl: sloUrl || null,
            cert: cert || null,
            nameIdFormat,
            signAssertion,
            signResponse,
            wantAuthnRequestsSigned,
            allowedAttributes,
            enabled: true,
        });

        const requestMetadata = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            kind: "saml_sp_created",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            detail: { entityId, name },
        });

        return { create: true };
    },

    // ── SP 수정 ────────────────────────────────────────────────────────────────
    update: async (event) => {
        const { locals } = event;
        const { db, tenant } = requireAdminContext(locals);

        const fd = await event.request.formData();
        const id = String(fd.get("id") ?? "");
        const name = String(fd.get("name") ?? "").trim();
        const acsUrl = String(fd.get("acsUrl") ?? "").trim();
        const sloUrl = String(fd.get("sloUrl") ?? "").trim();
        const nameIdFormat = String(fd.get("nameIdFormat") ?? "").trim();
        const cert = String(fd.get("cert") ?? "").trim();
        const signAssertion = fd.get("signAssertion") === "true";
        const signResponse = fd.get("signResponse") === "true";
        const wantAuthnRequestsSigned = fd.get("wantAuthnRequestsSigned") === "true";
        const enabled = fd.get("enabled") === "true";
        const allowedAttributes = parseAllowedAttributes(String(fd.get("allowedAttributes") ?? ""));

        if (!id || !name || !acsUrl) return fail(400, { error: "필수 항목이 누락되었습니다." });

        await db
            .update(samlSps)
            .set({
                name,
                acsUrl,
                sloUrl: sloUrl || null,
                cert: cert || null,
                nameIdFormat,
                signAssertion,
                signResponse,
                wantAuthnRequestsSigned,
                allowedAttributes,
                enabled,
                updatedAt: new Date(),
            })
            .where(and(eq(samlSps.id, id), eq(samlSps.tenantId, tenant.id)));

        return { update: true };
    },

    // ── SP 삭제 ────────────────────────────────────────────────────────────────
    delete: async (event) => {
        const { locals } = event;
        const { db, tenant } = requireAdminContext(locals);

        const fd = await event.request.formData();
        const id = String(fd.get("id") ?? "");
        if (!id) return fail(400, { error: "잘못된 요청입니다." });

        await db.delete(samlSps).where(and(eq(samlSps.id, id), eq(samlSps.tenantId, tenant.id)));

        const requestMetadata = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            kind: "saml_sp_deleted",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            detail: { spId: id },
        });

        return { deleted: true };
    },
};

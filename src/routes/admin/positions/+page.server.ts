import { fail } from "@sveltejs/kit";
import { asc, and, eq } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireAdminContext } from "$lib/server/auth/guards";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import { positions } from "$lib/server/db/schema";

export const load: PageServerLoad = async ({ locals }) => {
    const { db, tenant } = requireAdminContext(locals);
    const rows = await db.select().from(positions).where(eq(positions.tenantId, tenant.id)).orderBy(asc(positions.level), asc(positions.name));
    return { positions: rows };
};

export const actions: Actions = {
    // ctrls H-ADMIN-1: 직급 변경은 권한 매핑에 영향이 있으므로 모든 변경을 audit 기록.
    create: async (event) => {
        const { locals, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const name = String(fd.get("name") ?? "").trim();
        const code = String(fd.get("code") ?? "").trim() || null;
        const level = parseInt(String(fd.get("level") ?? "0"), 10);

        if (!name) return fail(400, { create: true, error: "직급명을 입력해 주세요." });
        if (isNaN(level)) return fail(400, { create: true, error: "레벨은 숫자여야 합니다." });

        await db.insert(positions).values({
            tenantId: tenant.id,
            name,
            code,
            level,
        });
        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            kind: "position_created",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { name, code, level },
        });
        return { created: true };
    },

    update: async (event) => {
        const { locals, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const id = String(fd.get("id") ?? "");
        const name = String(fd.get("name") ?? "").trim();
        const code = String(fd.get("code") ?? "").trim() || null;
        const level = parseInt(String(fd.get("level") ?? "0"), 10);

        if (!id || !name) return fail(400, { error: "잘못된 요청입니다." });

        await db
            .update(positions)
            .set({ name, code, level, updatedAt: new Date() })
            .where(and(eq(positions.id, id), eq(positions.tenantId, tenant.id)));
        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            kind: "position_updated",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { id, name, code, level },
        });
        return { updated: true };
    },

    delete: async (event) => {
        const { locals, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const id = String(fd.get("id") ?? "");
        if (!id) return fail(400, { error: "잘못된 요청입니다." });

        await db.delete(positions).where(and(eq(positions.id, id), eq(positions.tenantId, tenant.id)));
        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            kind: "position_deleted",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { id },
        });
        return { deleted: true };
    },
};

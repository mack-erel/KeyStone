import { fail } from "@sveltejs/kit";
import { asc, and, eq } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireAdminContext } from "$lib/server/auth/guards";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import { departments } from "$lib/server/db/schema";

// ctrls C-11: 부서 트리는 최대 깊이 제한 + 순환 참조 차단.
// 간접 순환(A→B→A, A→B→C→A 등)을 막지 않으면 traversal 코드가 무한루프
// (Workers CPU 타임아웃) 에 빠지고 권한 상속 계산이 깨진다.
const MAX_DEPARTMENT_DEPTH = 8;

type ValidateOpts = {
    db: ReturnType<typeof requireAdminContext>["db"];
    tenantId: string;
    /** 업데이트 대상 부서 id (create 시 null) */
    selfId: string | null;
    /** 새로 설정하려는 부모 id */
    newParentId: string | null;
};

async function validateParentHierarchy({ db, tenantId, selfId, newParentId }: ValidateOpts): Promise<string | null> {
    if (!newParentId) return null; // 루트로 설정 — 항상 OK
    if (selfId && newParentId === selfId) {
        return "자기 자신을 상위 부서로 설정할 수 없습니다.";
    }

    // 같은 tenant 의 부서 그래프를 한 번에 메모리로 — 부서 수 가 적은 운영 가정.
    const rows = await db.select({ id: departments.id, parentId: departments.parentId }).from(departments).where(eq(departments.tenantId, tenantId));
    const parentById = new Map(rows.map((r) => [r.id, r.parentId] as const));

    // newParentId 가 같은 tenant 안에 존재해야 함
    if (!parentById.has(newParentId)) {
        return "상위 부서를 찾을 수 없습니다.";
    }

    // newParentId 부터 root 까지 ancestor 체인을 따라가며 cycle / 깊이 검사
    let cursor: string | null = newParentId;
    const seen = new Set<string>();
    for (let depth = 1; depth <= MAX_DEPARTMENT_DEPTH; depth++) {
        if (cursor === null) return null; // root 도달 — OK
        if (selfId && cursor === selfId) {
            return "상위 부서 체인에 자기 자신이 포함되어 순환 참조가 발생합니다.";
        }
        if (seen.has(cursor)) {
            // tenant 내 다른 부서끼리 이미 cycle 이 있다는 뜻 — 기존 데이터 손상.
            return "상위 부서 트리에 순환 참조가 존재합니다. 관리자에게 문의하세요.";
        }
        seen.add(cursor);
        cursor = parentById.get(cursor) ?? null;
    }
    return `상위 부서 깊이는 최대 ${MAX_DEPARTMENT_DEPTH} 단계까지 허용됩니다.`;
}

export const load: PageServerLoad = async ({ locals }) => {
    const { db, tenant } = requireAdminContext(locals);

    const rows = await db.select().from(departments).where(eq(departments.tenantId, tenant.id)).orderBy(asc(departments.displayOrder), asc(departments.name));

    // 부모 이름을 서버에서 매핑
    const nameById = new Map(rows.map((r) => [r.id, r.name]));
    const depts = rows.map((r) => ({
        ...r,
        parentName: r.parentId ? (nameById.get(r.parentId) ?? null) : null,
    }));

    // 상위 부서 선택용 목록 (활성 부서만)
    const allDepts = rows.filter((r) => r.status === "active").map((r) => ({ id: r.id, name: r.name }));

    return { departments: depts, allDepts };
};

export const actions: Actions = {
    // ctrls H-ADMIN-1: 부서 트리 변경은 권한 상속에 직결되므로 모든 변경을 audit 기록.
    create: async (event) => {
        const { locals, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const name = String(fd.get("name") ?? "").trim();
        const code = String(fd.get("code") ?? "").trim() || null;
        const parentId = String(fd.get("parentId") ?? "").trim() || null;
        const description = String(fd.get("description") ?? "").trim() || null;
        const displayOrder = parseInt(String(fd.get("displayOrder") ?? "0"), 10);

        if (!name) return fail(400, { create: true, error: "부서명을 입력해 주세요." });

        const hierarchyError = await validateParentHierarchy({ db, tenantId: tenant.id, selfId: null, newParentId: parentId });
        if (hierarchyError) return fail(400, { create: true, error: hierarchyError });

        await db.insert(departments).values({
            tenantId: tenant.id,
            name,
            code,
            parentId,
            description,
            displayOrder: isNaN(displayOrder) ? 0 : displayOrder,
        });
        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            kind: "department_created",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { name, code, parentId },
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
        const parentId = String(fd.get("parentId") ?? "").trim() || null;
        const description = String(fd.get("description") ?? "").trim() || null;
        const displayOrder = parseInt(String(fd.get("displayOrder") ?? "0"), 10);
        const status = String(fd.get("status") ?? "active") as "active" | "inactive";

        if (!id || !name) return fail(400, { error: "잘못된 요청입니다." });

        const hierarchyError = await validateParentHierarchy({ db, tenantId: tenant.id, selfId: id, newParentId: parentId });
        if (hierarchyError) return fail(400, { error: hierarchyError });

        await db
            .update(departments)
            .set({
                name,
                code,
                parentId,
                description,
                displayOrder: isNaN(displayOrder) ? 0 : displayOrder,
                status,
                updatedAt: new Date(),
            })
            .where(and(eq(departments.id, id), eq(departments.tenantId, tenant.id)));
        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            kind: "department_updated",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { id, name, code, parentId, status },
        });
        return { updated: true };
    },

    delete: async (event) => {
        const { locals, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const id = String(fd.get("id") ?? "");
        if (!id) return fail(400, { error: "잘못된 요청입니다." });

        await db.delete(departments).where(and(eq(departments.id, id), eq(departments.tenantId, tenant.id)));
        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            kind: "department_deleted",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { id },
        });
        return { deleted: true };
    },
};

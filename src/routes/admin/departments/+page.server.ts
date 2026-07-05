import { asc, eq } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { departments } from "$lib/server/db/schema";
import { createAdminCrudRoute, type CrudContext } from "$lib/server/admin/crud-factory";
import { departmentCreateSchema, departmentUpdateSchema } from "$lib/server/admin/schemas";

// ctrls C-11: 부서 트리는 최대 깊이 제한 + 순환 참조 차단.
// 간접 순환(A→B→A, A→B→C→A 등)을 막지 않으면 traversal 코드가 무한루프
// (Workers CPU 타임아웃) 에 빠지고 권한 상속 계산이 깨진다.
const MAX_DEPARTMENT_DEPTH = 8;

type ValidateOpts = {
    db: CrudContext["db"];
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

// ctrls H-ADMIN-1: 부서 트리 변경은 권한 상속에 직결되므로 모든 변경을 audit 기록.
const route = createAdminCrudRoute({
    table: departments,
    auditPrefix: "department",
    createSchema: departmentCreateSchema,
    updateSchema: departmentUpdateSchema,
    load: async ({ db, tenant }) => {
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
    },
    beforeCreate: (ctx, values) => validateParentHierarchy({ db: ctx.db, tenantId: ctx.tenant.id, selfId: null, newParentId: values.parentId }),
    beforeUpdate: (ctx, values) => validateParentHierarchy({ db: ctx.db, tenantId: ctx.tenant.id, selfId: values.id, newParentId: values.parentId }),
    buildCreateDetail: (v) => ({ name: v.name, code: v.code, parentId: v.parentId }),
    buildUpdateDetail: (id, v) => ({ id, name: v.name, code: v.code, parentId: v.parentId, status: v.status }),
});

export const load: PageServerLoad = route.load;
export const actions: Actions = route.actions;

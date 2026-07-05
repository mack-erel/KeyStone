import { asc, and, eq } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { departments, teams } from "$lib/server/db/schema";
import { createAdminCrudRoute, type CrudContext } from "$lib/server/admin/crud-factory";
import { teamCreateSchema, teamUpdateSchema } from "$lib/server/admin/schemas";

/**
 * departmentId 참조 무결성: 지정된 부서가 존재하고 동일 tenant 인지 확인.
 * (없거나 타 tenant → 에러 메시지)
 */
async function validateDepartmentRef(ctx: CrudContext, departmentId: string | null): Promise<string | null> {
    if (!departmentId) return null;
    const [row] = await ctx.db
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.id, departmentId), eq(departments.tenantId, ctx.tenant.id)))
        .limit(1);
    return row ? null : "선택한 부서를 찾을 수 없습니다.";
}

// ctrls H-ADMIN-1: 팀 변경은 권한 매핑에 영향이 있으므로 모든 변경을 audit 기록.
const route = createAdminCrudRoute({
    table: teams,
    auditPrefix: "team",
    createSchema: teamCreateSchema,
    updateSchema: teamUpdateSchema,
    load: async ({ db, tenant }) => {
        const rows = await db
            .select({
                id: teams.id,
                name: teams.name,
                code: teams.code,
                departmentId: teams.departmentId,
                departmentName: departments.name,
                status: teams.status,
                createdAt: teams.createdAt,
            })
            .from(teams)
            .leftJoin(departments, eq(teams.departmentId, departments.id))
            .where(eq(teams.tenantId, tenant.id))
            .orderBy(asc(departments.name), asc(teams.name));

        const allDepts = await db
            .select({ id: departments.id, name: departments.name })
            .from(departments)
            .where(and(eq(departments.tenantId, tenant.id), eq(departments.status, "active")))
            .orderBy(asc(departments.name));

        return { teams: rows, allDepts };
    },
    beforeCreate: (ctx, values) => validateDepartmentRef(ctx, values.departmentId),
    beforeUpdate: (ctx, values) => validateDepartmentRef(ctx, values.departmentId),
    buildCreateDetail: (v) => ({ name: v.name, code: v.code, departmentId: v.departmentId }),
    buildUpdateDetail: (id, v) => ({ id, name: v.name, code: v.code, departmentId: v.departmentId, status: v.status }),
});

export const load: PageServerLoad = route.load;
export const actions: Actions = route.actions;

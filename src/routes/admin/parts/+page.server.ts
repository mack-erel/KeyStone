import { asc, and, eq } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { departments, parts, teams } from "$lib/server/db/schema";
import { createAdminCrudRoute, type CrudContext } from "$lib/server/admin/crud-factory";
import { partCreateSchema, partUpdateSchema } from "$lib/server/admin/schemas";

/**
 * teamId 참조 무결성: 지정된 팀이 존재하고 동일 tenant 인지 확인.
 * (없거나 타 tenant → 에러 메시지)
 */
async function validateTeamRef(ctx: CrudContext, teamId: string | null): Promise<string | null> {
    if (!teamId) return null;
    const [row] = await ctx.db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.id, teamId), eq(teams.tenantId, ctx.tenant.id)))
        .limit(1);
    return row ? null : "선택한 팀을 찾을 수 없습니다.";
}

// ctrls H-ADMIN-1: 파트 변경은 권한 매핑에 영향이 있으므로 모든 변경을 audit 기록.
const route = createAdminCrudRoute({
    table: parts,
    auditPrefix: "part",
    createSchema: partCreateSchema,
    updateSchema: partUpdateSchema,
    load: async ({ db, tenant }) => {
        const rows = await db
            .select({
                id: parts.id,
                name: parts.name,
                code: parts.code,
                teamId: parts.teamId,
                teamName: teams.name,
                departmentName: departments.name,
                status: parts.status,
                createdAt: parts.createdAt,
            })
            .from(parts)
            .leftJoin(teams, eq(parts.teamId, teams.id))
            .leftJoin(departments, eq(teams.departmentId, departments.id))
            .where(eq(parts.tenantId, tenant.id))
            .orderBy(asc(departments.name), asc(teams.name), asc(parts.name));

        // 팀 선택용 목록 (활성 팀만, 부서명 포함)
        const allTeams = await db
            .select({
                id: teams.id,
                name: teams.name,
                departmentName: departments.name,
            })
            .from(teams)
            .leftJoin(departments, eq(teams.departmentId, departments.id))
            .where(and(eq(teams.tenantId, tenant.id), eq(teams.status, "active")))
            .orderBy(asc(departments.name), asc(teams.name));

        return { parts: rows, allTeams };
    },
    beforeCreate: (ctx, values) => validateTeamRef(ctx, values.teamId),
    beforeUpdate: (ctx, values) => validateTeamRef(ctx, values.teamId),
    buildCreateDetail: (v) => ({ name: v.name, code: v.code, teamId: v.teamId }),
    buildUpdateDetail: (id, v) => ({ id, name: v.name, code: v.code, teamId: v.teamId, status: v.status }),
});

export const load: PageServerLoad = route.load;
export const actions: Actions = route.actions;

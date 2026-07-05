import { asc, eq } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { positions } from "$lib/server/db/schema";
import { createAdminCrudRoute } from "$lib/server/admin/crud-factory";
import { positionCreateSchema, positionUpdateSchema } from "$lib/server/admin/schemas";

// ctrls H-ADMIN-1: 직급 변경은 권한 매핑에 영향이 있으므로 모든 변경을 audit 기록.
// level 정수 검증은 zod(positionCreate/UpdateSchema)로 흡수한다.
const route = createAdminCrudRoute({
    table: positions,
    auditPrefix: "position",
    createSchema: positionCreateSchema,
    updateSchema: positionUpdateSchema,
    load: async ({ db, tenant }) => {
        const rows = await db.select().from(positions).where(eq(positions.tenantId, tenant.id)).orderBy(asc(positions.level), asc(positions.name));
        return { positions: rows };
    },
    buildCreateDetail: (v) => ({ name: v.name, code: v.code, level: v.level }),
    buildUpdateDetail: (id, v) => ({ id, name: v.name, code: v.code, level: v.level }),
});

export const load: PageServerLoad = route.load;
export const actions: Actions = route.actions;

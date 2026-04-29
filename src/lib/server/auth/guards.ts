import { error, fail } from "@sveltejs/kit";
import { and, eq, ne } from "drizzle-orm";
import type { DB } from "$lib/server/db";
import { users } from "$lib/server/db/schema";

export function requireDbContext(locals: App.Locals) {
    if (!locals.db || !locals.tenant) {
        throw error(503, locals.runtimeError ?? 'D1 binding "DB" 를 찾을 수 없습니다. Wrangler preview/dev 환경에서 실행 중인지 확인해 주세요.');
    }

    return { db: locals.db, tenant: locals.tenant };
}

/**
 * 관리자 전용 엔드포인트 가드.
 * +layout.server.ts load 는 form action 제출 시 실행되지 않으므로,
 * 모든 admin action 핸들러에서 반드시 이 함수를 사용해야 한다.
 */
export function requireAdminContext(locals: App.Locals) {
    const ctx = requireDbContext(locals);
    if (!locals.user) {
        throw error(401, "로그인이 필요합니다.");
    }
    if (locals.user.role !== "admin") {
        throw error(403, "관리자 권한이 필요합니다.");
    }
    return { ...ctx, user: locals.user };
}

/**
 * 마지막 관리자 보호 가드.
 * `userIdToBeChanged` 가 활성 admin 이면서, 같은 테넌트에 다른 활성 admin 이 없으면
 * 변경(강등/disable/locked/delete)을 거부한다.
 *
 * 사용 시점: admin → user 강등, status를 active 가 아닌 값으로 변경, 사용자 삭제.
 * 일반 user → admin 승격은 호출하지 않아도 된다.
 *
 * 반환값: 차단해야 하면 SvelteKit `fail(400, ...)` 형태의 ActionFailure, 통과면 `null`.
 */
export async function assertNotLastAdmin(
    db: DB,
    tenantId: string,
    userIdToBeChanged: string,
): Promise<ReturnType<typeof fail> | null> {
    const [target] = await db
        .select({ id: users.id, role: users.role, status: users.status })
        .from(users)
        .where(and(eq(users.id, userIdToBeChanged), eq(users.tenantId, tenantId)))
        .limit(1);

    // 대상이 없거나 이미 admin/active 가 아니면 last-admin 검사가 의미 없음
    if (!target) return null;
    if (target.role !== "admin" || target.status !== "active") return null;

    const otherAdmins = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.role, "admin"), eq(users.status, "active"), ne(users.id, userIdToBeChanged)))
        .limit(1);

    if (otherAdmins.length === 0) {
        return fail(400, { error: "마지막 활성 관리자입니다. 먼저 다른 관리자를 지정해 주세요." });
    }
    return null;
}

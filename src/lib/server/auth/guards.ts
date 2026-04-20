import { error } from "@sveltejs/kit";

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

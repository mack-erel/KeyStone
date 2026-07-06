import type { RequestEvent } from "@sveltejs/kit";
import { requireAdminContext, assertUserInTenant } from "$lib/server/auth/guards";
import { revokeAllUserSessions } from "$lib/server/auth/session";
import { revokeAllUserRefreshTokens } from "$lib/server/oidc/refresh";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";

// 사용자 상세 페이지의 보안 관련 액션(강제 로그아웃 등).
type UserActionEvent = RequestEvent<{ id: string }, "/admin/users/[id]">;

// ── 강제 로그아웃 ──────────────────────────────────────────────────────────
// 상태/비밀번호 변경 없이 대상 유저의 모든 세션 + OIDC refresh token 을 폐기한다.
// revokeAllUserSessions 는 세션만 무효화하고 refresh token 은 별도 store 이므로,
// resetPassword/role 변경 액션과 동일한 폐기 조합(세션 + refresh token)을 사용한다.
export async function forceLogout(event: UserActionEvent) {
    const { locals, params, request } = event;
    const { db, tenant } = requireAdminContext(locals);
    const userId = params.id;

    // ctrls C-13: cross-tenant IDOR 차단 — 대상이 본 테넌트 user 인지 검증.
    const tenantCheck = await assertUserInTenant(db, tenant.id, userId);
    if (!tenantCheck.ok) return tenantCheck.error;

    // 폼 요청 파싱(사용 값은 없지만 액션 계약 일관성 유지).
    await request.formData();

    await revokeAllUserSessions(db, userId);
    await revokeAllUserRefreshTokens(db, userId);

    const meta = getRequestMetadata(event);
    await recordAuditEvent(db, {
        tenantId: tenant.id,
        userId,
        actorId: locals.user!.id,
        kind: "sessions_revoked",
        outcome: "success",
        ip: meta.ip,
        userAgent: meta.userAgent,
    });

    return { forcedLogout: true };
}

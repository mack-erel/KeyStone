import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getRequestMetadata, recordAuditEvent } from "$lib/server/audit";
import { requireDbContext } from "$lib/server/auth/guards";
import { clearSessionCookie, listActiveSessions, revokeAllUserSessions, revokeOtherSessions, revokeSessionById } from "$lib/server/auth/session";
import { revokeAllUserRefreshTokens, revokeRefreshTokensForSession } from "$lib/server/oidc/refresh";
import { dispatchSecurityAlert } from "$lib/server/security-notify";
import { translate } from "$lib/i18n/server";

export const load: PageServerLoad = async ({ locals, url }) => {
    if (!locals.user) {
        throw redirect(303, `/login?redirectTo=${encodeURIComponent(url.pathname)}`);
    }

    const { db } = requireDbContext(locals);
    const activeSessions = await listActiveSessions(db, locals.user.id);

    return {
        sessions: activeSessions,
        currentSessionId: locals.session?.id ?? null,
    };
};

export const actions: Actions = {
    // 개별 세션 로그아웃. sessionId + userId 동시 일치(IDOR 방지)만 폐기하고,
    // 해당 세션에 묶인 OIDC refresh token 도 함께 폐기(offline_access 연쇄 무효화).
    revoke: async (event) => {
        const { locals } = event;
        if (!locals.user) throw redirect(303, "/login");

        const { db, tenant } = requireDbContext(locals);
        const formData = await event.request.formData();
        const sessionId = String(formData.get("id") ?? "").trim();
        if (!sessionId) {
            return fail(400, { error: translate(locals.locale, "sessions.err_select_session") });
        }

        const revoked = await revokeSessionById(db, sessionId, locals.user.id);
        if (!revoked) {
            return fail(404, { error: translate(locals.locale, "sessions.err_not_found") });
        }

        // 세션 폐기와 세트로 refresh token 연쇄 폐기.
        await revokeRefreshTokensForSession(db, sessionId);

        const requestMetadata = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: locals.user.id,
            actorId: locals.user.id,
            kind: "session_revoked",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            detail: { sessionId },
        });

        // 보안 알림(best-effort, waitUntil 격리). 본인 직접 철회에도 발송한다 — 세션 탈취 방어.
        // 현재 세션 철회(=로그아웃) 케이스도 아래 redirect 전에 일관 발송한다.
        dispatchSecurityAlert({ to: locals.user.email, locale: locals.user.locale, kind: "session_revoked", platform: event.platform });

        // 현재 세션을 스스로 폐기하면 사실상 로그아웃 — 쿠키를 지우고 로그인으로 보낸다.
        if (locals.session?.id === sessionId) {
            clearSessionCookie(event.cookies, event.url);
            throw redirect(303, "/login");
        }

        return { revoked: true };
    },

    // 현재 세션을 제외한 모든 세션 로그아웃. 폐기 대상 세션들의 refresh token 도 함께 폐기.
    revokeOthers: async (event) => {
        const { locals } = event;
        if (!locals.user) throw redirect(303, "/login");

        const { db, tenant } = requireDbContext(locals);
        const currentSessionId = locals.session?.id ?? "";

        // 폐기 전에 대상 세션 id 를 수집(현재 세션 제외) → refresh 연쇄 폐기에 사용.
        const active = await listActiveSessions(db, locals.user.id);
        const otherIds = active.map((s) => s.id).filter((id) => id !== currentSessionId);

        await revokeOtherSessions(db, locals.user.id, currentSessionId);
        for (const id of otherIds) {
            await revokeRefreshTokensForSession(db, id);
        }

        const requestMetadata = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: locals.user.id,
            actorId: locals.user.id,
            kind: "sessions_revoked",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            detail: { count: otherIds.length },
        });

        // 보안 알림(best-effort, waitUntil 격리). 실제 폐기된 다른 세션이 있을 때만 발송한다.
        if (otherIds.length > 0) {
            dispatchSecurityAlert({ to: locals.user.email, locale: locals.user.locale, kind: "sessions_revoked_all", platform: event.platform });
        }

        return { revokedOthers: true };
    },

    // 일괄 로그아웃 — 현재 세션을 포함한 모든 세션 + 모든 OIDC refresh token 폐기.
    // 관리자 강제 로그아웃(forceLogout)과 동일한 폐기 조합을 셀프서비스로 제공한다.
    revokeAll: async (event) => {
        const { locals } = event;
        if (!locals.user) throw redirect(303, "/login");

        const { db, tenant } = requireDbContext(locals);
        const active = await listActiveSessions(db, locals.user.id);

        await revokeAllUserSessions(db, locals.user.id);
        await revokeAllUserRefreshTokens(db, locals.user.id);

        const requestMetadata = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: locals.user.id,
            actorId: locals.user.id,
            kind: "sessions_revoked",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            detail: { all: true, count: active.length },
        });

        // 보안 알림(best-effort, waitUntil 격리) — 세션 탈취 방어를 위해 항상 발송한다.
        dispatchSecurityAlert({ to: locals.user.email, locale: locals.user.locale, kind: "sessions_revoked_all", platform: event.platform });

        // 현재 세션도 폐기되었으므로 쿠키를 지우고 로그인으로 보낸다.
        clearSessionCookie(event.cookies, event.url);
        throw redirect(303, "/login");
    },
};

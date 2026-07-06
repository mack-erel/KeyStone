import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getRequestMetadata, recordAuditEvent } from "$lib/server/audit";
import { requireDbContext } from "$lib/server/auth/guards";
import { clearSessionCookie, listActiveSessions, revokeOtherSessions, revokeSessionById } from "$lib/server/auth/session";
import { revokeRefreshTokensForSession } from "$lib/server/oidc/refresh";

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
            return fail(400, { error: "세션을 지정해 주세요." });
        }

        const revoked = await revokeSessionById(db, sessionId, locals.user.id);
        if (!revoked) {
            return fail(404, { error: "세션을 찾을 수 없습니다." });
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

        return { revokedOthers: true };
    },
};

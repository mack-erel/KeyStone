import { redirect } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getRequestMetadata, recordAuditEvent } from "$lib/server/audit";
import { requireDbContext } from "$lib/server/auth/guards";
import { clearSessionCookie, revokeSession } from "$lib/server/auth/session";
import { SESSION_COOKIE_NAME } from "$lib/server/auth/constants";
import { getActiveSigningKey } from "$lib/server/crypto/keys";
import { getOidcBackchannelTargets, sendOneBackchannelLogout } from "$lib/server/oidc/logout";

/**
 * IdP-initiated 로그아웃.
 *
 * 브라우저 기반 FC / SAML HTTP-Redirect SLO 는 form 제출→redirect 흐름에서
 * iframe 렌더가 불가능하므로 이 라우트에서는 제공하지 않는다.
 * (그런 플로우는 /oidc/end-session 이나 /saml/slo 로부터 진입해야 한다.)
 *
 * 단, OIDC back-channel 과 SAML IdP-initiated 서버 측 발송은 best-effort 로
 * waitUntil 을 통해 발사한 뒤 /login 으로 리다이렉트한다.
 */
async function performLogout(event: RequestEvent) {
    const sessionToken = event.cookies.get(SESSION_COOKIE_NAME);

    if (sessionToken && event.locals.db && event.locals.tenant && event.locals.session && event.locals.user) {
        const { db, tenant } = requireDbContext(event.locals);
        const requestMetadata = getRequestMetadata(event);

        // 세션 값 캡처 (폐기 전)
        const sessionId = event.locals.session.id;
        const idpSessionId = event.locals.session.idpSessionId;
        const userId = event.locals.user.id;

        // OIDC back-channel 로그아웃 발송 (waitUntil)
        const issuerUrl = event.locals.runtimeConfig.issuerUrl ?? event.url.origin;
        const signingKeySecret = event.locals.runtimeConfig.signingKeySecret;
        if (signingKeySecret) {
            const bcTargets = await getOidcBackchannelTargets(db, tenant.id, sessionId);
            if (bcTargets.length > 0) {
                const signingKey = await getActiveSigningKey(db, tenant.id, signingKeySecret);
                if (signingKey) {
                    const bcPromises = bcTargets.map((t) => sendOneBackchannelLogout(t, userId, idpSessionId, issuerUrl, signingKey.privateKey, signingKey.kid).catch(() => undefined));
                    const wait = event.platform?.ctx?.waitUntil?.bind(event.platform.ctx);
                    if (wait) {
                        wait(Promise.all(bcPromises));
                    } else {
                        await Promise.all(bcPromises);
                    }
                }
            }
        }

        await revokeSession(db, idpSessionId);

        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId,
            actorId: userId,
            kind: "logout",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
        });
    }

    clearSessionCookie(event.cookies, event.url);
}

export const load: PageServerLoad = async ({ locals }) => {
    if (!locals.user) throw redirect(303, "/login");
    return {};
};

export const actions: Actions = {
    default: async (event) => {
        await performLogout(event);
        throw redirect(303, "/login");
    },
};

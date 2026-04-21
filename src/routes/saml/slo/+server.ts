/**
 * SAML 2.0 Single Logout (SLO) 엔드포인트 — SP-initiated.
 *
 * GET /saml/slo
 *   - SAMLRequest(LogoutRequest) 파싱 → SessionIndex 로 해당 SAML 세션 식별
 *   - SP 인증서가 등록돼 있으면 HTTP-Redirect 서명 검증
 *   - 해당 SAML 세션 종료 (endedAt)
 *   - 같은 IdP 세션에 묶인 다른 SP 를 대상으로 best-effort 로그아웃
 *     (iframe 기반 FC, JS-free; HTTP-Redirect 바인딩 SP 만)
 *   - OIDC back-channel 로그아웃은 waitUntil 로 발송
 *   - IdP 세션 폐기, LogoutResponse 로 원 SP 에 302
 *
 * SAMLRequest 가 없으면 단순히 세션만 폐기하고 "/" 로 리다이렉트.
 */

import { error, redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq } from "drizzle-orm";
import { samlSessions, samlSps, sessions } from "$lib/server/db/schema";
import { getRequestMetadata, recordAuditEvent } from "$lib/server/audit";
import { requireDbContext } from "$lib/server/auth/guards";
import { SESSION_COOKIE_NAME } from "$lib/server/auth/constants";
import { getActiveSigningKey } from "$lib/server/crypto/keys";
import { getOidcBackchannelTargets, sendOneBackchannelLogout } from "$lib/server/oidc/logout";
import { buildSamlLogoutRequest, buildSamlLogoutResponse, buildSamlSloRedirectUrl, getActiveSamlSessionsForSession, parseSamlLogoutRequest } from "$lib/server/saml/slo";
import { verifySamlRedirectSignature } from "$lib/server/saml/parse-authn-request";

function htmlEscape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export const GET: RequestHandler = async (event) => {
    const { locals, url, cookies, platform } = event;
    const { db, tenant } = requireDbContext(locals);

    const samlRequest = url.searchParams.get("SAMLRequest");
    const relayState = url.searchParams.get("RelayState");

    // SAMLRequest 없으면 세션만 폐기하고 홈으로 (IdP 콘솔 테스트 등)
    if (!samlRequest) {
        if (locals.session) {
            await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, locals.session.id));
            cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
        }
        throw redirect(302, "/");
    }

    // 1. LogoutRequest 파싱
    let parsed;
    try {
        parsed = await parseSamlLogoutRequest(samlRequest);
    } catch {
        throw error(400, "Invalid SAMLRequest");
    }

    // 2. SP 조회 (issuer = entityId)
    const [sp] = await db
        .select()
        .from(samlSps)
        .where(and(eq(samlSps.tenantId, tenant.id), eq(samlSps.entityId, parsed.issuer), eq(samlSps.enabled, true)))
        .limit(1);
    if (!sp) {
        throw error(400, "Unknown SAML SP");
    }

    // 3. 서명 검증 (SP cert 가 있으면 필수)
    if (sp.cert) {
        const rawQuery = url.search.replace(/^\?/, "");
        const valid = await verifySamlRedirectSignature(rawQuery, sp.cert);
        if (!valid) {
            throw error(400, "Invalid SAMLRequest signature");
        }
    }

    // 4. SessionIndex → SAML 세션 및 IdP 세션 식별
    //    (동일 SP 가 여러 SessionIndex 를 보낼 수 있으나 M3 기준 하나만 처리)
    const targetSessionIndex = parsed.sessionIndexes[0];
    let idpSession: typeof sessions.$inferSelect | null = null;
    let linkedSamlSessionId: string | null = null;
    if (targetSessionIndex) {
        const [row] = await db
            .select({ samlSessionId: samlSessions.id, idpSessionId: samlSessions.sessionId })
            .from(samlSessions)
            .where(and(eq(samlSessions.tenantId, tenant.id), eq(samlSessions.spId, sp.id), eq(samlSessions.sessionIndex, targetSessionIndex)))
            .limit(1);
        if (row) {
            linkedSamlSessionId = row.samlSessionId;
            if (row.idpSessionId) {
                const [s] = await db.select().from(sessions).where(eq(sessions.id, row.idpSessionId)).limit(1);
                idpSession = s ?? null;
            }
        }
    }
    // fallback — 현재 브라우저 세션
    if (!idpSession && locals.session) idpSession = locals.session;

    // 5. SAML 세션 종료
    if (linkedSamlSessionId) {
        await db.update(samlSessions).set({ endedAt: new Date() }).where(eq(samlSessions.id, linkedSamlSessionId));
    }

    // 6. 다른 활성 SAML 세션 수집 (best-effort FC 로그아웃용)
    let otherSamlIframeUris: string[] = [];
    if (idpSession) {
        const siblings = await getActiveSamlSessionsForSession(db, idpSession.id);
        const remaining = siblings.filter((s) => s.id !== linkedSamlSessionId);
        const issuerUrl = locals.runtimeConfig.issuerUrl ?? url.origin;
        const signingKeySecret = locals.runtimeConfig.signingKeySecret;
        const signingKey = signingKeySecret ? await getActiveSigningKey(db, tenant.id, signingKeySecret) : null;

        if (signingKey) {
            const urls: string[] = [];
            for (const s of remaining) {
                if (!s.sp.sloUrl) continue;
                const lrXml = buildSamlLogoutRequest({
                    id: `_l${crypto.randomUUID().replace(/-/g, "")}`,
                    issuerUrl,
                    destination: s.sp.sloUrl,
                    nameId: s.nameId,
                    nameIdFormat: s.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
                    sessionIndex: s.sessionIndex,
                });
                try {
                    const signed = await buildSamlSloRedirectUrl({
                        sloUrl: s.sp.sloUrl,
                        xml: lrXml,
                        param: "SAMLRequest",
                        privateKey: signingKey.privateKey,
                    });
                    urls.push(signed);
                } catch {
                    // skip
                }
            }
            otherSamlIframeUris = urls;
        }

        // IdP 관점에서 이 세션에 묶인 모든 SAML 세션을 종료로 표시한다.
        // (서명 키가 없어 FC 알림을 못 보내더라도 IdP DB 는 일관성을 유지해야 함.)
        await db.update(samlSessions).set({ endedAt: new Date() }).where(eq(samlSessions.sessionId, idpSession.id));
    }

    // 7. OIDC BC 로그아웃 (waitUntil)
    if (idpSession && locals.runtimeConfig.signingKeySecret) {
        const bcTargets = await getOidcBackchannelTargets(db, tenant.id, idpSession.id);
        if (bcTargets.length > 0) {
            const signingKey = await getActiveSigningKey(db, tenant.id, locals.runtimeConfig.signingKeySecret);
            if (signingKey) {
                const issuerUrl = locals.runtimeConfig.issuerUrl ?? url.origin;
                const bcPromises = bcTargets.map((t) =>
                    sendOneBackchannelLogout(t, idpSession.userId, idpSession.idpSessionId, issuerUrl, signingKey.privateKey, signingKey.kid).catch(() => undefined),
                );
                const wait = platform?.ctx?.waitUntil?.bind(platform.ctx);
                if (wait) {
                    wait(Promise.all(bcPromises));
                } else {
                    await Promise.all(bcPromises);
                }
            }
        }
    }

    // 8. IdP 세션 폐기
    if (idpSession) {
        await db
            .update(sessions)
            .set({ revokedAt: new Date() })
            .where(and(eq(sessions.id, idpSession.id), eq(sessions.tenantId, tenant.id)));
        if (locals.user) {
            const requestMetadata = getRequestMetadata(event);
            await recordAuditEvent(db, {
                tenantId: tenant.id,
                userId: locals.user.id,
                actorId: locals.user.id,
                kind: "saml_slo",
                outcome: "success",
                ip: requestMetadata.ip,
                userAgent: requestMetadata.userAgent,
                detail: { spEntityId: parsed.issuer },
            });
        }
        cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
    }

    // 9. LogoutResponse 생성 → SP 로 리다이렉트
    if (!sp.sloUrl) {
        throw redirect(302, "/");
    }
    const issuerUrl = locals.runtimeConfig.issuerUrl ?? url.origin;
    const responseXml = buildSamlLogoutResponse({
        id: `_lr${crypto.randomUUID().replace(/-/g, "")}`,
        inResponseTo: parsed.id,
        issuerUrl,
        destination: sp.sloUrl,
        status: "Success",
    });

    const signingKeySecret = locals.runtimeConfig.signingKeySecret;
    if (!signingKeySecret) {
        // 서명키 없으면 부득이하게 미서명 응답은 불가 → 세션만 폐기하고 홈으로
        throw redirect(302, "/");
    }
    const signingKey = await getActiveSigningKey(db, tenant.id, signingKeySecret);
    if (!signingKey) {
        throw redirect(302, "/");
    }
    const redirectUrl = await buildSamlSloRedirectUrl({
        sloUrl: sp.sloUrl,
        xml: responseXml,
        param: "SAMLResponse",
        relayState,
        privateKey: signingKey.privateKey,
    });

    // 다른 SP 들이 남아 있으면 iframe 으로 선 로그아웃 시도 후 3초 뒤 리다이렉트
    if (otherSamlIframeUris.length > 0) {
        const iframes = otherSamlIframeUris.map((u) => `<iframe src="${htmlEscape(u)}" style="display:none" sandbox="allow-same-origin allow-scripts"></iframe>`).join("");
        const html =
            `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">` +
            `<title>Logging out...</title>` +
            `<meta http-equiv="refresh" content="3;url=${htmlEscape(redirectUrl)}">` +
            `</head><body><p>로그아웃 중...</p>${iframes}</body></html>`;
        return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    throw redirect(302, redirectUrl);
};

export const POST: RequestHandler = (event) => GET(event);

/**
 * SAML 2.0 Single Logout (SLO) 엔드포인트 — 순차 리다이렉트 체인 구현.
 *
 * 한 번의 브라우저 네비게이션에서 여러 SP 를 로그아웃시키기 위해, 체인 상태를
 * `samlSloStates` 테이블에 저장하고 RelayState 로 `samlSloStates.id` 를 전달해
 * 각 SP 의 응답을 받아 다음 SP 로 이어간다.
 *
 * 처리 분기 (쿼리 파라미터 기준):
 *   A. SAMLResponse + RelayState : 체인 진행 중인 SP 로부터의 LogoutResponse 수신
 *      → 다음 pending SP 로 리다이렉트하거나, 없으면 체인 종료
 *   B. state            : IdP-initiated SLO 체인 시작 (로그아웃 페이지에서 진입)
 *   C. SAMLRequest      : SP-initiated SLO 시작
 *   D. 그 외             : 세션만 폐기하고 /
 */

import { error, redirect } from "@sveltejs/kit";
import type { RequestEvent, RequestHandler } from "./$types";
import { and, eq, gt } from "drizzle-orm";
import { samlSessions, samlSloStates, samlSps, sessions } from "$lib/server/db/schema";
import { getRequestMetadata, recordAuditEvent } from "$lib/server/audit";
import { requireDbContext } from "$lib/server/auth/guards";
import { SESSION_COOKIE_NAME } from "$lib/server/auth/constants";
import { getActiveSigningKey } from "$lib/server/crypto/keys";
import { getOidcBackchannelTargets, sendOneBackchannelLogout } from "$lib/server/oidc/logout";
import { buildSamlLogoutRequest, buildSamlLogoutResponse, buildSamlSloRedirectUrl, collectPendingSpData, parseSamlLogoutRequest, type PendingSpData } from "$lib/server/saml/slo";
import { verifySamlRedirectSignature } from "$lib/server/saml/parse-authn-request";

const SLO_STATE_TTL_MS = 10 * 60 * 1000; // 10 분

function parsePendingSpData(json: string): PendingSpData[] {
    try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        return parsed as PendingSpData[];
    } catch {
        return [];
    }
}

async function fireOidcBackchannelLogout(event: RequestEvent, idpSession: typeof sessions.$inferSelect): Promise<void> {
    const { locals, platform, url } = event;
    const { db, tenant } = requireDbContext(locals);
    const signingKeySecret = locals.runtimeConfig.signingKeySecret;
    if (!signingKeySecret) return;

    const bcTargets = await getOidcBackchannelTargets(db, tenant.id, idpSession.id);
    if (bcTargets.length === 0) return;

    const signingKey = await getActiveSigningKey(db, tenant.id, signingKeySecret);
    if (!signingKey) return;

    const issuerUrl = locals.runtimeConfig.issuerUrl ?? url.origin;
    const bcPromises = bcTargets.map((t) => sendOneBackchannelLogout(t, idpSession.userId, idpSession.idpSessionId, issuerUrl, signingKey.privateKey, signingKey.kid).catch(() => undefined));
    const wait = platform?.ctx?.waitUntil?.bind(platform.ctx);
    if (wait) {
        wait(Promise.all(bcPromises));
    } else {
        await Promise.all(bcPromises);
    }
}

/**
 * 체인의 다음 SP 에게 서명된 LogoutRequest 를 보낸다.
 * pendingSpDataJson 을 먼저 업데이트한 뒤(처리할 SP 를 맨 앞에서 제거) 리다이렉트한다.
 * 이렇게 해야 사용자가 새로 고침해도 같은 SP 가 중복 처리되지 않는다.
 */
async function redirectToNextSp(event: RequestEvent, stateId: string, remaining: PendingSpData[]): Promise<never> {
    const { locals, url } = event;
    const { db, tenant } = requireDbContext(locals);

    if (remaining.length === 0) {
        throw error(500, "체인에 남은 SP 가 없습니다");
    }

    const next = remaining[0];
    const rest = remaining.slice(1);

    // 먼저 DB 를 업데이트한다 (next SP 를 pending 에서 제거).
    await db
        .update(samlSloStates)
        .set({ pendingSpDataJson: JSON.stringify(rest) })
        .where(eq(samlSloStates.id, stateId));

    const signingKeySecret = locals.runtimeConfig.signingKeySecret;
    if (!signingKeySecret) {
        throw error(500, "서명 키가 설정되지 않아 SLO 체인을 계속 진행할 수 없습니다");
    }
    const signingKey = await getActiveSigningKey(db, tenant.id, signingKeySecret);
    if (!signingKey) {
        throw error(500, "활성 서명 키가 없습니다");
    }

    const issuerUrl = locals.runtimeConfig.issuerUrl ?? url.origin;
    const lrXml = buildSamlLogoutRequest({
        id: `_l${crypto.randomUUID().replace(/-/g, "")}`,
        issuerUrl,
        destination: next.sloUrl,
        nameId: next.nameId,
        nameIdFormat: next.nameIdFormat,
        sessionIndex: next.sessionIndex,
    });

    const redirectUrl = await buildSamlSloRedirectUrl({
        sloUrl: next.sloUrl,
        xml: lrXml,
        param: "SAMLRequest",
        relayState: stateId,
        privateKey: signingKey.privateKey,
    });

    throw redirect(302, redirectUrl);
}

/**
 * 체인 종료 처리: IdP 세션을 폐기하고 쿠키를 제거한 뒤, OIDC BC 로그아웃을
 * waitUntil 로 발송하고 state 행을 삭제한다. 최종 리다이렉트는 호출자가 수행한다.
 */
async function completeSloChain(event: RequestEvent, state: typeof samlSloStates.$inferSelect): Promise<void> {
    const { locals, cookies } = event;
    const { db, tenant } = requireDbContext(locals);

    // 1. 연결된 IdP 세션 조회 (아직 revoke 되지 않았다면)
    const [idpSession] = await db.select().from(sessions).where(eq(sessions.id, state.idpSessionRecordId)).limit(1);

    // 2. 남아있는 SAML 세션 전체를 endedAt 으로 표시 (일관성 유지)
    if (idpSession) {
        await db.update(samlSessions).set({ endedAt: new Date() }).where(eq(samlSessions.sessionId, idpSession.id));
    }

    // 3. OIDC BC 로그아웃 발송 (waitUntil)
    if (idpSession) {
        await fireOidcBackchannelLogout(event, idpSession);
    }

    // 4. IdP 세션 폐기
    if (idpSession && !idpSession.revokedAt) {
        await db
            .update(sessions)
            .set({ revokedAt: new Date() })
            .where(and(eq(sessions.id, idpSession.id), eq(sessions.tenantId, tenant.id)));
    }

    // 5. 쿠키 제거
    cookies.delete(SESSION_COOKIE_NAME, { path: "/" });

    // 6. state 행 삭제
    await db.delete(samlSloStates).where(eq(samlSloStates.id, state.id));
}

export const GET: RequestHandler = async (event) => {
    const { locals, url, cookies } = event;
    const { db, tenant } = requireDbContext(locals);

    const samlRequest = url.searchParams.get("SAMLRequest");
    const samlResponse = url.searchParams.get("SAMLResponse");
    const relayState = url.searchParams.get("RelayState");
    const stateParam = url.searchParams.get("state");

    // ── Case A: SAMLResponse + RelayState → 체인 진행 중인 SP 의 응답 처리 ─────
    if (samlResponse && relayState) {
        const [state] = await db
            .select()
            .from(samlSloStates)
            .where(and(eq(samlSloStates.id, relayState), eq(samlSloStates.tenantId, tenant.id), gt(samlSloStates.expiresAt, new Date())))
            .limit(1);
        if (!state) {
            throw error(400, "Invalid or expired SLO state");
        }

        // pendingSpDataJson 에 남아 있는 SP 목록 (현재 응답을 보낸 SP 는 이미 제거된 상태)
        const remaining = parsePendingSpData(state.pendingSpDataJson);

        // 다음 SP 가 있으면 이어서 진행
        if (remaining.length > 0) {
            await redirectToNextSp(event, state.id, remaining);
            // 위에서 redirect throw
        }

        // 남은 SP 가 없으면 체인 종료
        await completeSloChain(event, state);

        // SP-initiated 였다면 최초 SP 로 LogoutResponse 를 돌려준다.
        if (state.initiatorSloUrl && state.inResponseTo) {
            const signingKeySecret = locals.runtimeConfig.signingKeySecret;
            if (signingKeySecret) {
                const signingKey = await getActiveSigningKey(db, tenant.id, signingKeySecret);
                if (signingKey) {
                    const issuerUrl = locals.runtimeConfig.issuerUrl ?? url.origin;
                    const responseXml = buildSamlLogoutResponse({
                        id: `_lr${crypto.randomUUID().replace(/-/g, "")}`,
                        inResponseTo: state.inResponseTo,
                        issuerUrl,
                        destination: state.initiatorSloUrl,
                        status: "Success",
                    });
                    const redirectUrl = await buildSamlSloRedirectUrl({
                        sloUrl: state.initiatorSloUrl,
                        xml: responseXml,
                        param: "SAMLResponse",
                        privateKey: signingKey.privateKey,
                    });
                    throw redirect(302, redirectUrl);
                }
            }
            // 서명 키가 없으면 completionUri 로 폴백
        }

        throw redirect(302, state.completionUri);
    }

    // ── Case B: state 파라미터 → IdP-initiated 체인 시작 ────────────────────────
    if (stateParam) {
        const [state] = await db
            .select()
            .from(samlSloStates)
            .where(and(eq(samlSloStates.id, stateParam), eq(samlSloStates.tenantId, tenant.id), gt(samlSloStates.expiresAt, new Date())))
            .limit(1);
        if (!state) {
            throw error(400, "Invalid or expired SLO state");
        }

        const pending = parsePendingSpData(state.pendingSpDataJson);

        if (pending.length === 0) {
            // 엣지 케이스: pending 이 없는데 state 만 있음 → 바로 종료
            await completeSloChain(event, state);
            throw redirect(302, state.completionUri);
        }

        await redirectToNextSp(event, state.id, pending);
        // redirect throw
    }

    // ── Case C: SAMLRequest → SP-initiated SLO 시작 ─────────────────────────────
    if (samlRequest) {
        let parsed;
        try {
            parsed = await parseSamlLogoutRequest(samlRequest);
        } catch {
            throw error(400, "Invalid SAMLRequest");
        }

        // SP 조회
        const [sp] = await db
            .select()
            .from(samlSps)
            .where(and(eq(samlSps.tenantId, tenant.id), eq(samlSps.entityId, parsed.issuer), eq(samlSps.enabled, true)))
            .limit(1);
        if (!sp) {
            throw error(400, "Unknown SAML SP");
        }

        // 서명 검증 (SP cert 가 있으면 필수)
        if (sp.cert) {
            const rawQuery = url.search.replace(/^\?/, "");
            const valid = await verifySamlRedirectSignature(rawQuery, sp.cert);
            if (!valid) {
                throw error(400, "Invalid SAMLRequest signature");
            }
        }

        // SessionIndex → SAML 세션 및 IdP 세션 식별
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
        if (!idpSession && locals.session) idpSession = locals.session;

        // 초기 SP 의 SAML 세션 종료
        if (linkedSamlSessionId) {
            await db.update(samlSessions).set({ endedAt: new Date() }).where(eq(samlSessions.id, linkedSamlSessionId));
        }

        // 감사 로그
        if (idpSession && locals.user) {
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

        // 남은 SP 수집 (초기 요청 SP 제외)
        const pending: PendingSpData[] = idpSession ? await collectPendingSpData(db, idpSession.id, parsed.issuer) : [];

        // 남은 SP 가 없으면: 세션 폐기, BC 로그아웃 발송, sp 로 LogoutResponse 반환
        if (pending.length === 0) {
            // IdP 세션 일괄 종료 표시
            if (idpSession) {
                await db.update(samlSessions).set({ endedAt: new Date() }).where(eq(samlSessions.sessionId, idpSession.id));
                await fireOidcBackchannelLogout(event, idpSession);
                if (!idpSession.revokedAt) {
                    await db
                        .update(sessions)
                        .set({ revokedAt: new Date() })
                        .where(and(eq(sessions.id, idpSession.id), eq(sessions.tenantId, tenant.id)));
                }
            }
            cookies.delete(SESSION_COOKIE_NAME, { path: "/" });

            if (!sp.sloUrl) {
                throw redirect(302, "/");
            }
            const signingKeySecret = locals.runtimeConfig.signingKeySecret;
            if (!signingKeySecret) {
                throw redirect(302, "/");
            }
            const signingKey = await getActiveSigningKey(db, tenant.id, signingKeySecret);
            if (!signingKey) {
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
            const redirectUrl = await buildSamlSloRedirectUrl({
                sloUrl: sp.sloUrl,
                xml: responseXml,
                param: "SAMLResponse",
                relayState,
                privateKey: signingKey.privateKey,
            });
            throw redirect(302, redirectUrl);
        }

        // 남은 SP 가 있으면: samlSloState 생성 후 첫 SP 로 체인 시작
        if (!idpSession) {
            // 이론적으로 pending.length > 0 이려면 idpSession 이 있었어야 한다.
            throw error(500, "SLO 체인 초기화 실패");
        }

        const stateId = crypto.randomUUID();
        const nowMs = Date.now();
        await db.insert(samlSloStates).values({
            id: stateId,
            tenantId: tenant.id,
            idpSessionRecordId: idpSession.id,
            userId: idpSession.userId,
            initiatingSpEntityId: parsed.issuer,
            inResponseTo: parsed.id,
            initiatorSloUrl: sp.sloUrl ?? null,
            completionUri: sp.sloUrl ?? "/login",
            pendingSpDataJson: JSON.stringify(pending),
            expiresAt: new Date(nowMs + SLO_STATE_TTL_MS),
        });

        await redirectToNextSp(event, stateId, pending);
        // redirect throw
    }

    // ── Case D: 그 외 fallback — 세션만 폐기하고 / 로 ───────────────────────────
    if (locals.session) {
        await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, locals.session.id));
        cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
    }
    throw redirect(302, "/");
};

export const POST: RequestHandler = (event) => GET(event);

import { json, error } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import { createSessionRecord, revokeOtherSessions, setSessionCookie } from "$lib/server/auth/session";
import { sanitizeRedirectTarget } from "$lib/server/auth/redirect";
import { AMR_WEBAUTHN, amrToAcr } from "$lib/server/auth/constants";
import { checkRateLimit } from "$lib/server/ratelimit";
import { verifyPasskeyAuthentication, consumeChallenge, getWebAuthnConfig } from "$lib/server/auth/webauthn";
import type { AuthenticationResponseJSON } from "$lib/server/auth/webauthn";
import { users } from "$lib/server/db/schema";

function extractChallengeFromClientData(clientDataJSONb64u: string): string | null {
    try {
        const b64 = clientDataJSONb64u.replace(/-/g, "+").replace(/_/g, "/");
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const obj = JSON.parse(new TextDecoder().decode(arr)) as { challenge?: string };
        return typeof obj.challenge === "string" ? obj.challenge : null;
    } catch {
        return null;
    }
}

export const POST: RequestHandler = async (event) => {
    const { locals, cookies, request, url } = event;

    const { rpID, origin } = getWebAuthnConfig(url);

    // CSRF/Origin 검증: 같은 origin 에서 호출됐는지 확인.
    const reqOrigin = request.headers.get("origin");
    const referer = request.headers.get("referer");
    const refOrigin = referer
        ? (() => {
              try {
                  return new URL(referer).origin;
              } catch {
                  return null;
              }
          })()
        : null;
    if (reqOrigin && reqOrigin !== origin) {
        throw error(403, "유효하지 않은 출처입니다.");
    }
    if (!reqOrigin && refOrigin && refOrigin !== origin) {
        throw error(403, "유효하지 않은 출처입니다.");
    }

    const body = (await request.json()) as AuthenticationResponseJSON & { _redirectTo?: string };

    const { db, tenant } = requireDbContext(locals);
    const ip = (request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();

    // 레이트 리밋: tenant + ip 기반 (body.id 는 클라이언트가 임의 변조 가능하므로 키로 부적합).
    const rlKey = `webauthn-verify:${tenant.id}:${ip}`;
    const rl = await checkRateLimit(db, rlKey, { windowMs: 5 * 60 * 1000, limit: 10 });
    if (!rl.allowed) {
        throw error(429, "인증 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.");
    }

    // 1회용 challenge 소진 (DB 기반)
    const clientChallenge = body.response?.clientDataJSON ? extractChallengeFromClientData(body.response.clientDataJSON) : null;
    if (!clientChallenge) {
        throw error(400, "인증 세션이 유효하지 않습니다.");
    }
    const challengeOk = await consumeChallenge(db, tenant.id, clientChallenge);
    if (!challengeOk) {
        throw error(400, "인증 세션이 만료되었거나 이미 사용되었습니다.");
    }

    const result = await verifyPasskeyAuthentication(db, body, clientChallenge, rpID, origin, tenant.id);

    if (!result) {
        const requestMetadata = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            kind: "login",
            outcome: "failure",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            detail: { method: "webauthn" },
        });
        throw error(400, "패스키 인증에 실패했습니다.");
    }

    // 사용자 조회
    const [user] = await db.select().from(users).where(eq(users.id, result.userId)).limit(1);

    if (!user || user.status !== "active") {
        throw error(403, "비활성화된 계정입니다.");
    }

    if (user.tenantId !== tenant.id) {
        throw error(403, "접근 권한이 없습니다.");
    }

    const requestMetadata = getRequestMetadata(event);
    const { sessionToken, expiresAt, sessionId } = await createSessionRecord(db, {
        tenantId: tenant.id,
        userId: user.id,
        ip: requestMetadata.ip,
        userAgent: requestMetadata.userAgent,
        amr: [AMR_WEBAUTHN],
        acr: amrToAcr([AMR_WEBAUTHN]),
    });

    // 기존 세션 회수 — 새 세션만 살아남도록.
    await revokeOtherSessions(db, user.id, sessionId);

    setSessionCookie(cookies, url, sessionToken, expiresAt);

    await recordAuditEvent(db, {
        tenantId: tenant.id,
        userId: user.id,
        actorId: user.id,
        kind: "login",
        outcome: "success",
        ip: requestMetadata.ip,
        userAgent: requestMetadata.userAgent,
        detail: { method: "webauthn" },
    });

    // SAML/OIDC 플로우에서 전달된 redirectTo 를 우선 사용 (내부 경로만 허용)
    const sanitized = sanitizeRedirectTarget(body._redirectTo ?? "");
    const safeRedirect = sanitized ?? (user.role === "admin" ? "/admin" : "/");

    return json({ ok: true, redirectTo: safeRedirect });
};

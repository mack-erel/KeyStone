import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import { checkRateLimit } from "$lib/server/ratelimit";
import { verifyChallengeCookie, verifyRegistrationResponse, savePasskey, getWebAuthnConfig, WEBAUTHN_CHALLENGE_COOKIE } from "$lib/server/auth/webauthn";
import type { RegistrationResponseJSON } from "$lib/server/auth/webauthn";

/**
 * 패스키 라벨에서 제어문자/BIDI override 등 위험 코드포인트를 제거한다.
 * 출력 시 svelte 가 escape 해주지만 저장 단계에서 미리 정리해 둔다.
 */
function sanitizePasskeyLabel(label: string): string {
    let out = "";
    for (const ch of label) {
        const code = ch.codePointAt(0) ?? 0;
        if (code <= 0x1f || code === 0x7f) continue; // C0 + DEL
        if (code >= 0x80 && code <= 0x9f) continue; // C1
        if (code === 0x200e || code === 0x200f) continue; // LRM/RLM
        if (code >= 0x202a && code <= 0x202e) continue; // BIDI override
        if (code >= 0x2066 && code <= 0x2069) continue; // BIDI isolate
        if (code === 0xfeff) continue; // BOM
        out += ch;
    }
    return out.trim().slice(0, 64);
}

export const POST: RequestHandler = async (event) => {
    const { locals, cookies, request, url, platform } = event;
    if (!locals.user) {
        throw error(401, "로그인이 필요합니다.");
    }

    const { rpID, origin } = getWebAuthnConfig(url);

    // Origin 검증
    const reqOrigin = request.headers.get("origin");
    if (reqOrigin && reqOrigin !== origin) {
        throw error(403, "유효하지 않은 출처입니다.");
    }

    const config = getRuntimeConfig(platform);
    if (!config.signingKeySecret) {
        throw error(503, "IDP_SIGNING_KEY_SECRET 이 설정되지 않았습니다.");
    }

    const cookieValue = cookies.get(WEBAUTHN_CHALLENGE_COOKIE);
    if (!cookieValue) {
        throw error(400, "등록 세션이 만료되었습니다. 다시 시도해 주세요.");
    }

    const payload = await verifyChallengeCookie(cookieValue, config.signingKeySecret, "register");
    if (!payload || payload.userId !== locals.user.id) {
        cookies.delete(WEBAUTHN_CHALLENGE_COOKIE, { path: "/" });
        throw error(400, "등록 세션이 유효하지 않습니다. 다시 시도해 주세요.");
    }

    const body = (await request.json()) as RegistrationResponseJSON & { label?: string };
    const label = typeof body.label === "string" ? sanitizePasskeyLabel(body.label) : "";

    const { db: dbForRl, tenant: tenantForRl } = requireDbContext(locals);
    const ip = (request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    const rl = await checkRateLimit(dbForRl, `webauthn-register-verify:${tenantForRl.id}:${ip}`, { windowMs: 5 * 60 * 1000, limit: 10 });
    if (!rl.allowed) {
        throw error(429, "등록 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.");
    }

    const verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: payload.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
    });

    cookies.delete(WEBAUTHN_CHALLENGE_COOKIE, { path: "/" });

    if (!verification.verified || !verification.registrationInfo) {
        throw error(400, "패스키 등록 검증에 실패했습니다.");
    }

    const { db, tenant } = requireDbContext(locals);
    await savePasskey(db, locals.user.id, label, verification);

    const requestMetadata = getRequestMetadata(event);
    await recordAuditEvent(db, {
        tenantId: tenant.id,
        userId: locals.user.id,
        actorId: locals.user.id,
        kind: "passkey_registered",
        outcome: "success",
        ip: requestMetadata.ip,
        userAgent: requestMetadata.userAgent,
    });

    return json({ ok: true });
};

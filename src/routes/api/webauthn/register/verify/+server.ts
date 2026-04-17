import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import {
    verifyChallengeCookie,
    verifyRegistrationResponse,
    savePasskey,
    getWebAuthnConfig,
    WEBAUTHN_CHALLENGE_COOKIE,
} from "$lib/server/auth/webauthn";
import type { RegistrationResponseJSON } from "$lib/server/auth/webauthn";

export const POST: RequestHandler = async (event) => {
    const { locals, cookies, request, url, platform } = event;
    if (!locals.user) {
        throw error(401, "로그인이 필요합니다.");
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
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 64) : "";

    const { rpID, origin } = getWebAuthnConfig(url);

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

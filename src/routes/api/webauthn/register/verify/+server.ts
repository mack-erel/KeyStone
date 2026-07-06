import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import { dispatchSecurityAlert } from "$lib/server/security-notify";
import { checkRateLimit } from "$lib/server/ratelimit";
import { verifyChallengeCookie, verifyRegistrationResponse, savePasskey, getWebAuthnConfig, WEBAUTHN_CHALLENGE_COOKIE } from "$lib/server/auth/webauthn";
import type { RegistrationResponseJSON } from "$lib/server/auth/webauthn";
import { tryWithSecretsNullable } from "$lib/server/crypto/keys";
import { translate } from "$lib/i18n/server";

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
        throw error(401, translate(locals.locale, "webauthn.errors.login_required"));
    }

    const { rpID, origin } = getWebAuthnConfig(url);

    // Origin 검증
    const reqOrigin = request.headers.get("origin");
    if (reqOrigin && reqOrigin !== origin) {
        throw error(403, translate(locals.locale, "webauthn.errors.invalid_origin"));
    }

    const config = getRuntimeConfig(platform);
    if (config.signingKeySecrets.length === 0) {
        throw error(503, translate(locals.locale, "webauthn.errors.signing_key_not_configured"));
    }

    const cookieValue = cookies.get(WEBAUTHN_CHALLENGE_COOKIE);
    if (!cookieValue) {
        throw error(400, translate(locals.locale, "webauthn.errors.register_session_expired"));
    }

    const payload = await tryWithSecretsNullable(config.signingKeySecrets, (s) => verifyChallengeCookie(cookieValue, s, "register"));
    if (!payload || payload.userId !== locals.user.id) {
        cookies.delete(WEBAUTHN_CHALLENGE_COOKIE, { path: "/" });
        throw error(400, translate(locals.locale, "webauthn.errors.register_session_invalid"));
    }

    const body = (await request.json()) as RegistrationResponseJSON & { label?: string };
    const label = typeof body.label === "string" ? sanitizePasskeyLabel(body.label) : "";

    const { tenant: tenantForRl, rateLimitStore } = requireDbContext(locals);
    // cf-connecting-ip 전용(H-ADMIN-3) + IPv6 /64 정규화(C6). 위조 가능한 x-forwarded-for 는 쓰지 않는다.
    const { ipKey } = getRequestMetadata(event);
    const rl = await checkRateLimit(rateLimitStore, `webauthn-register-verify:${tenantForRl.id}:${ipKey}`, { windowMs: 5 * 60 * 1000, limit: 10 });
    if (!rl.allowed) {
        throw error(429, translate(locals.locale, "webauthn.errors.register_rate_limited"));
    }

    const verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: payload.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
    });

    cookies.delete(WEBAUTHN_CHALLENGE_COOKIE, { path: "/" });

    if (!verification.verified || !verification.registrationInfo) {
        throw error(400, translate(locals.locale, "webauthn.errors.register_verify_failed"));
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

    dispatchSecurityAlert({ to: locals.user.email, locale: locals.user.locale, kind: "passkey_added", platform });

    return json({ ok: true });
};

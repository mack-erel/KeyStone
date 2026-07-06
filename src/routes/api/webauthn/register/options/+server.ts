import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { buildRegistrationOptions, createChallengeCookie, getWebAuthnConfig, WEBAUTHN_CHALLENGE_COOKIE } from "$lib/server/auth/webauthn";
import { translate } from "$lib/i18n/server";

export const POST: RequestHandler = async (event) => {
    const { locals, cookies, url, platform } = event;
    if (!locals.user) {
        throw error(401, translate(locals.locale, "webauthn.errors.login_required"));
    }

    const config = getRuntimeConfig(platform);
    if (!config.signingKeySecret) {
        throw error(503, translate(locals.locale, "webauthn.errors.signing_key_not_configured"));
    }

    const { db } = requireDbContext(locals);
    const { rpID, rpName, origin } = getWebAuthnConfig(url);

    const options = await buildRegistrationOptions(db, locals.user.id, locals.user.email, locals.user.displayName, rpID, rpName);

    // challenge 를 HMAC-서명 쿠키에 저장
    const cookieValue = await createChallengeCookie({ challenge: options.challenge, type: "register", userId: locals.user.id }, config.signingKeySecret);

    cookies.set(WEBAUTHN_CHALLENGE_COOKIE, cookieValue, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: origin.startsWith("https:"),
        maxAge: 5 * 60,
    });

    return json(options);
};

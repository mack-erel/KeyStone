import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { buildAuthenticationOptions, getWebAuthnConfig, saveChallenge } from "$lib/server/auth/webauthn";
import { checkRateLimit } from "$lib/server/ratelimit";
import { getRequestMetadata } from "$lib/server/audit";
import { translate } from "$lib/i18n/server";

export const POST: RequestHandler = async (event) => {
    const { url, locals, request } = event;
    const { db, tenant, rateLimitStore } = requireDbContext(locals);
    const { rpID, origin } = getWebAuthnConfig(url);

    // Origin 검증 — 외부 사이트가 challenge 를 강탈/누적시키지 못하게.
    const reqOrigin = request.headers.get("origin");
    if (reqOrigin && reqOrigin !== origin) {
        throw error(403, translate(locals.locale, "webauthn.errors.invalid_origin"));
    }

    // ctrls H-AUTH-2: rate-limit. 익명 호출자가 무제한으로 challenge 를 생성해
    // webauthn_challenges 테이블을 채우는 (D1 storage exhaustion / latency 증가)
    // 면적을 차단. tenant + IP 키, 5분에 30회.
    const meta = getRequestMetadata(event);
    const rl = await checkRateLimit(rateLimitStore, `webauthn-options:${tenant.id}:${meta.ipKey}`, { windowMs: 5 * 60 * 1000, limit: 30 });
    if (!rl.allowed) {
        throw error(429, translate(locals.locale, "webauthn.errors.rate_limited_retry", { seconds: Math.ceil(rl.retryAfterMs / 1000) }));
    }

    const options = await buildAuthenticationOptions(rpID);
    await saveChallenge(db, tenant.id, options.challenge);

    return json(options);
};

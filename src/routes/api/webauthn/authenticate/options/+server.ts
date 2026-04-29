import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { buildAuthenticationOptions, getWebAuthnConfig, saveChallenge } from "$lib/server/auth/webauthn";

export const POST: RequestHandler = async ({ url, locals, request }) => {
    const { db, tenant } = requireDbContext(locals);
    const { rpID, origin } = getWebAuthnConfig(url);

    // Origin 검증 — 외부 사이트가 challenge 를 강탈/누적시키지 못하게.
    const reqOrigin = request.headers.get("origin");
    if (reqOrigin && reqOrigin !== origin) {
        throw error(403, "유효하지 않은 출처입니다.");
    }

    const options = await buildAuthenticationOptions(rpID);
    await saveChallenge(db, tenant.id, options.challenge);

    return json(options);
};

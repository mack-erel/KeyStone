import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import {
    buildAuthenticationOptions,
    getWebAuthnConfig,
    saveChallenge,
} from "$lib/server/auth/webauthn";

export const POST: RequestHandler = async ({ url, locals }) => {
    const { db } = requireDbContext(locals);
    const { rpID } = getWebAuthnConfig(url);

    const options = await buildAuthenticationOptions(rpID);
    await saveChallenge(db, options.challenge);

    return json(options);
};

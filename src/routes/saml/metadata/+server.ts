import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { generateIdpMetadataXml } from "$lib/server/saml/metadata";

export const GET: RequestHandler = async ({ locals, platform }) => {
    const { db, tenant } = requireDbContext(locals);
    const config = getRuntimeConfig(platform);

    if (!config.issuerUrl) {
        throw error(503, "IDP_ISSUER_URL 미설정");
    }

    const xml = await generateIdpMetadataXml(db, tenant.id, config.issuerUrl);

    return new Response(xml, {
        headers: {
            "Content-Type": "application/samlmetadata+xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
        },
    });
};

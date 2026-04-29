import { fail } from "@sveltejs/kit";
import { desc, eq, and } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireAdminContext } from "$lib/server/auth/guards";
import { clientSkins, oidcClients, samlSps } from "$lib/server/db/schema";
import { invalidateSkinCache } from "$lib/server/skin/resolver";

const MAX_SKIN_CACHE_TTL_SECONDS = 86400; // 1일

function validateSkinFetchUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { ok: false, reason: "유효한 URL을 입력해 주세요." };
    }
    if (url.protocol !== "https:") {
        return { ok: false, reason: "https URL만 허용됩니다." };
    }
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
        return { ok: false, reason: "loopback 주소는 사용할 수 없습니다." };
    }
    if (/^127\./.test(host) || /^169\.254\./.test(host)) {
        return { ok: false, reason: "내부망/메타데이터 주소는 사용할 수 없습니다." };
    }
    return { ok: true, url };
}

export const load: PageServerLoad = async ({ locals }) => {
    const { db, tenant } = requireAdminContext(locals);

    const [skins, oidcList, samlList] = await Promise.all([
        db.select().from(clientSkins).where(eq(clientSkins.tenantId, tenant.id)).orderBy(desc(clientSkins.createdAt)),
        db.select({ id: oidcClients.id, name: oidcClients.name, clientId: oidcClients.clientId }).from(oidcClients).where(eq(oidcClients.tenantId, tenant.id)),
        db.select({ id: samlSps.id, name: samlSps.name, entityId: samlSps.entityId }).from(samlSps).where(eq(samlSps.tenantId, tenant.id)),
    ]);

    return { skins, oidcList, samlList };
};

export const actions: Actions = {
    create: async ({ request, locals }) => {
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();

        const clientType = fd.get("clientType") as "oidc" | "saml";
        const clientRefId = String(fd.get("clientRefId") ?? "").trim();
        const skinType = (fd.get("skinType") ?? "login") as "login" | "signup" | "find_id" | "find_password" | "mfa" | "reset_password";
        const fetchUrl = String(fd.get("fetchUrl") ?? "").trim();
        const fetchSecret = String(fd.get("fetchSecret") ?? "").trim() || null;
        const cacheTtlSeconds = Number(fd.get("cacheTtlSeconds") ?? 3600);

        if (!clientType || !clientRefId || !fetchUrl) {
            return fail(400, { create: true, error: "필수 항목을 입력해 주세요." });
        }
        if (clientType !== "oidc" && clientType !== "saml") {
            return fail(400, { create: true, error: "clientType이 올바르지 않습니다." });
        }

        const v = validateSkinFetchUrl(fetchUrl);
        if (!v.ok) return fail(400, { create: true, error: v.reason });

        const ttl = isNaN(cacheTtlSeconds) ? 3600 : cacheTtlSeconds;
        if (ttl < 0) return fail(400, { create: true, error: "cacheTtlSeconds 는 0 이상이어야 합니다." });
        if (ttl > MAX_SKIN_CACHE_TTL_SECONDS) {
            return fail(400, { create: true, error: `cacheTtlSeconds 는 ${MAX_SKIN_CACHE_TTL_SECONDS} 초(1일) 를 초과할 수 없습니다.` });
        }

        try {
            await db.insert(clientSkins).values({
                tenantId: tenant.id,
                clientType,
                clientRefId,
                skinType,
                fetchUrl,
                fetchSecret: fetchSecret && fetchSecret.length > 0 ? fetchSecret : null,
                cacheTtlSeconds: ttl,
                enabled: true,
            });
        } catch {
            return fail(409, { create: true, error: "이미 동일한 클라이언트/스킨 타입 설정이 있습니다." });
        }

        return { created: true };
    },

    delete: async ({ request, locals, platform }) => {
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const id = String(fd.get("id") ?? "");

        const [skin] = await db
            .select()
            .from(clientSkins)
            .where(and(eq(clientSkins.id, id), eq(clientSkins.tenantId, tenant.id)))
            .limit(1);

        if (!skin) return fail(404, { error: "스킨을 찾을 수 없습니다." });

        await invalidateSkinCache(platform, tenant.id, skin.clientType, skin.clientRefId, skin.skinType);
        await db.delete(clientSkins).where(eq(clientSkins.id, id));

        return { deleted: true };
    },

    toggleEnabled: async ({ request, locals }) => {
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const id = String(fd.get("id") ?? "");

        const [skin] = await db
            .select()
            .from(clientSkins)
            .where(and(eq(clientSkins.id, id), eq(clientSkins.tenantId, tenant.id)))
            .limit(1);

        if (!skin) return fail(404, { error: "스킨을 찾을 수 없습니다." });

        await db.update(clientSkins).set({ enabled: !skin.enabled }).where(eq(clientSkins.id, id));

        return { toggled: true };
    },

    invalidateCache: async ({ request, locals, platform }) => {
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const id = String(fd.get("id") ?? "");

        const [skin] = await db
            .select()
            .from(clientSkins)
            .where(and(eq(clientSkins.id, id), eq(clientSkins.tenantId, tenant.id)))
            .limit(1);

        if (!skin) return fail(404, { error: "스킨을 찾을 수 없습니다." });

        await invalidateSkinCache(platform, tenant.id, skin.clientType, skin.clientRefId, skin.skinType);

        return { invalidated: true };
    },

    update: async ({ request, locals, platform }) => {
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const id = String(fd.get("id") ?? "").trim();
        const fetchUrl = String(fd.get("fetchUrl") ?? "").trim();
        const fetchSecret = String(fd.get("fetchSecret") ?? "").trim() || null;
        const cacheTtlSeconds = Number(fd.get("cacheTtlSeconds") ?? 3600);

        if (!fetchUrl) return fail(400, { update: true, updateId: id, error: "URL을 입력해 주세요." });

        const v = validateSkinFetchUrl(fetchUrl);
        if (!v.ok) return fail(400, { update: true, updateId: id, error: v.reason });

        const ttl = isNaN(cacheTtlSeconds) ? 3600 : cacheTtlSeconds;
        if (ttl < 0) return fail(400, { update: true, updateId: id, error: "cacheTtlSeconds 는 0 이상이어야 합니다." });
        if (ttl > MAX_SKIN_CACHE_TTL_SECONDS) {
            return fail(400, { update: true, updateId: id, error: `cacheTtlSeconds 는 ${MAX_SKIN_CACHE_TTL_SECONDS} 초(1일) 를 초과할 수 없습니다.` });
        }

        const [skin] = await db
            .select()
            .from(clientSkins)
            .where(and(eq(clientSkins.id, id), eq(clientSkins.tenantId, tenant.id)))
            .limit(1);

        if (!skin) return fail(404, { update: true, updateId: id, error: "스킨을 찾을 수 없습니다." });

        await db
            .update(clientSkins)
            .set({ fetchUrl, fetchSecret: fetchSecret && fetchSecret.length > 0 ? fetchSecret : null, cacheTtlSeconds: ttl })
            .where(eq(clientSkins.id, id));

        await invalidateSkinCache(platform, tenant.id, skin.clientType, skin.clientRefId, skin.skinType);

        return { updated: true };
    },
};

import { fail } from "@sveltejs/kit";
import { desc, eq, and } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireAdminContext } from "$lib/server/auth/guards";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import { oidcClients } from "$lib/server/db/schema";
import { hashPassword } from "$lib/server/auth/password";

function generateClientId(): string {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

function generateClientSecret(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function parseUris(raw: string): string {
    return JSON.stringify(
        raw
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean),
    );
}

export const load: PageServerLoad = async ({ locals }) => {
    const { db, tenant } = requireAdminContext(locals);
    const rows = await db
        .select({
            id: oidcClients.id,
            clientId: oidcClients.clientId,
            name: oidcClients.name,
            redirectUris: oidcClients.redirectUris,
            postLogoutRedirectUris: oidcClients.postLogoutRedirectUris,
            scopes: oidcClients.scopes,
            tokenEndpointAuthMethod: oidcClients.tokenEndpointAuthMethod,
            requirePkce: oidcClients.requirePkce,
            enabled: oidcClients.enabled,
            createdAt: oidcClients.createdAt,
        })
        .from(oidcClients)
        .where(eq(oidcClients.tenantId, tenant.id))
        .orderBy(desc(oidcClients.createdAt));

    return { clients: rows };
};

export const actions: Actions = {
    // ── 클라이언트 생성 ────────────────────────────────────────────────────────
    create: async (event) => {
        const { locals } = event;
        const { db, tenant } = requireAdminContext(locals);

        const fd = await event.request.formData();
        const name = String(fd.get("name") ?? "").trim();
        const redirectUrisRaw = String(fd.get("redirectUris") ?? "").trim();
        const postLogoutUrisRaw = String(fd.get("postLogoutRedirectUris") ?? "").trim();
        const scopes = String(fd.get("scopes") ?? "openid").trim();
        const tokenMethod = String(fd.get("tokenEndpointAuthMethod") ?? "client_secret_basic") as "client_secret_basic" | "client_secret_post" | "none";
        // public client(none)는 PKCE 필수
        const requirePkce = tokenMethod === "none" ? true : fd.get("requirePkce") === "true";

        if (!name) return fail(400, { create: true, error: "이름은 필수입니다." });
        if (!redirectUrisRaw) return fail(400, { create: true, error: "Redirect URI 는 필수입니다." });

        const clientId = generateClientId();
        const clientSecret = tokenMethod !== "none" ? generateClientSecret() : null;
        const clientSecretHashed = clientSecret ? await hashPassword(clientSecret) : null;

        await db.insert(oidcClients).values({
            id: crypto.randomUUID(),
            tenantId: tenant.id,
            clientId,
            clientSecretHash: clientSecretHashed,
            name,
            redirectUris: parseUris(redirectUrisRaw),
            postLogoutRedirectUris: postLogoutUrisRaw ? parseUris(postLogoutUrisRaw) : null,
            scopes,
            tokenEndpointAuthMethod: tokenMethod,
            requirePkce,
            enabled: true,
        });

        const requestMetadata = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            kind: "oidc_client_created",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            detail: { clientId, name },
        });

        // 생성 직후 시크릿을 1회 노출
        return { create: true, clientId, clientSecret };
    },

    // ── 클라이언트 수정 ────────────────────────────────────────────────────────
    update: async (event) => {
        const { locals } = event;
        const { db, tenant } = requireAdminContext(locals);

        const fd = await event.request.formData();
        const id = String(fd.get("id") ?? "");
        const name = String(fd.get("name") ?? "").trim();
        const redirectUrisRaw = String(fd.get("redirectUris") ?? "").trim();
        const postLogoutUrisRaw = String(fd.get("postLogoutRedirectUris") ?? "").trim();
        const scopes = String(fd.get("scopes") ?? "openid").trim();
        const enabled = fd.get("enabled") === "true";

        if (!id || !name) return fail(400, { error: "잘못된 요청입니다." });
        if (!redirectUrisRaw) return fail(400, { error: "Redirect URI 는 필수입니다." });

        // public client(none)는 PKCE를 수정 시에도 강제 유지
        const [existingClient] = await db
            .select({ tokenEndpointAuthMethod: oidcClients.tokenEndpointAuthMethod })
            .from(oidcClients)
            .where(and(eq(oidcClients.id, id), eq(oidcClients.tenantId, tenant.id)))
            .limit(1);
        const requirePkce = existingClient?.tokenEndpointAuthMethod === "none" ? true : fd.get("requirePkce") === "true";

        await db
            .update(oidcClients)
            .set({
                name,
                redirectUris: parseUris(redirectUrisRaw),
                postLogoutRedirectUris: postLogoutUrisRaw ? parseUris(postLogoutUrisRaw) : null,
                scopes,
                requirePkce,
                enabled,
                updatedAt: new Date(),
            })
            .where(and(eq(oidcClients.id, id), eq(oidcClients.tenantId, tenant.id)));

        const requestMetadata = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            kind: "oidc_client_updated",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            detail: { clientDbId: id, name, enabled },
        });

        return { update: true };
    },

    // ── 시크릿 재생성 ─────────────────────────────────────────────────────────
    regenerateSecret: async (event) => {
        const { locals } = event;
        const { db, tenant } = requireAdminContext(locals);

        const fd = await event.request.formData();
        const id = String(fd.get("id") ?? "");
        if (!id) return fail(400, { error: "잘못된 요청입니다." });

        const newSecret = generateClientSecret();
        const newSecretHashed = await hashPassword(newSecret);
        await db
            .update(oidcClients)
            .set({ clientSecretHash: newSecretHashed, updatedAt: new Date() })
            .where(and(eq(oidcClients.id, id), eq(oidcClients.tenantId, tenant.id)));

        const requestMetadata = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            kind: "oidc_client_secret_regenerated",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            detail: { clientDbId: id },
        });

        return { regenerateSecret: true, clientSecret: newSecret };
    },

    // ── 삭제 ─────────────────────────────────────────────────────────────────
    delete: async (event) => {
        const { locals } = event;
        const { db, tenant } = requireAdminContext(locals);

        const fd = await event.request.formData();
        const id = String(fd.get("id") ?? "");
        if (!id) return fail(400, { error: "잘못된 요청입니다." });

        await db.delete(oidcClients).where(and(eq(oidcClients.id, id), eq(oidcClients.tenantId, tenant.id)));

        const requestMetadata = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: locals.user!.id,
            kind: "oidc_client_deleted",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            detail: { clientDbId: id },
        });

        return { deleted: true };
    },
};

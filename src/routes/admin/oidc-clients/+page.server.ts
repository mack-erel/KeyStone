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

const ALLOWED_TOKEN_AUTH_METHODS = ["client_secret_basic", "client_secret_post", "none"] as const;
type TokenAuthMethod = (typeof ALLOWED_TOKEN_AUTH_METHODS)[number];

const ALLOWED_OIDC_SCOPES = ["openid", "profile", "email", "address", "phone", "offline_access", "groups"] as const;

function isLoopbackHost(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * 단일 redirect URI / post-logout / channel logout URL 검증.
 * @param value 검증할 URL 문자열
 * @param opts.allowCustomScheme 모바일 등 커스텀 scheme 허용 여부 (redirect_uri 한정)
 */
function validateClientUri(value: string, opts: { allowCustomScheme?: boolean } = {}): { ok: true } | { ok: false; reason: string } {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return { ok: false, reason: `URL 형식이 올바르지 않습니다: ${value}` };
    }

    // RFC 6749 §3.1.2 — fragment 포함 redirect URI 금지
    if (parsed.hash && parsed.hash.length > 0) {
        return { ok: false, reason: `fragment(#) 가 포함된 URI 는 허용되지 않습니다: ${value}` };
    }

    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    const blocked = ["javascript", "data", "file", "vbscript", "blob"];
    if (blocked.includes(scheme)) {
        return { ok: false, reason: `${scheme}: 스킴은 허용되지 않습니다.` };
    }

    if (scheme === "https") return { ok: true };
    if (scheme === "http") {
        if (isLoopbackHost(parsed.hostname)) return { ok: true };
        return { ok: false, reason: `http URL 은 localhost/127.0.0.1 만 허용됩니다: ${value}` };
    }
    if (opts.allowCustomScheme) {
        // 커스텀 scheme (모바일 redirect 등): RFC 3986 scheme 형식
        if (/^[a-z][a-z0-9+.-]*$/i.test(scheme)) return { ok: true };
        return { ok: false, reason: `커스텀 scheme 형식이 올바르지 않습니다: ${value}` };
    }
    return { ok: false, reason: `허용되지 않는 scheme 입니다 (${scheme}): ${value}` };
}

function splitUriList(raw: string): string[] {
    return raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function validateUriList(raw: string, label: string, opts: { allowCustomScheme?: boolean } = {}): { ok: true; json: string } | { ok: false; reason: string } {
    const list = splitUriList(raw);
    for (const v of list) {
        const r = validateClientUri(v, opts);
        if (!r.ok) return { ok: false, reason: `${label}: ${r.reason}` };
    }
    return { ok: true, json: JSON.stringify(list) };
}

function validateSingleUri(value: string, label: string): { ok: true } | { ok: false; reason: string } {
    if (!value) return { ok: true };
    const r = validateClientUri(value);
    if (!r.ok) return { ok: false, reason: `${label}: ${r.reason}` };
    return { ok: true };
}

function normalizeScopes(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
    const tokens = raw
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of tokens) {
        if (!(ALLOWED_OIDC_SCOPES as readonly string[]).includes(t)) {
            return { ok: false, reason: `허용되지 않는 scope 입니다: ${t}` };
        }
        if (!seen.has(t)) {
            seen.add(t);
            out.push(t);
        }
    }
    if (!seen.has("openid")) {
        return { ok: false, reason: "scope 에는 'openid' 가 포함되어야 합니다." };
    }
    return { ok: true, value: out.join(" ") };
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
            frontchannelLogoutUri: oidcClients.frontchannelLogoutUri,
            frontchannelLogoutSessionRequired: oidcClients.frontchannelLogoutSessionRequired,
            backchannelLogoutUri: oidcClients.backchannelLogoutUri,
            backchannelLogoutSessionRequired: oidcClients.backchannelLogoutSessionRequired,
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
        const frontchannelLogoutUri = String(fd.get("frontchannelLogoutUri") ?? "").trim();
        const backchannelLogoutUri = String(fd.get("backchannelLogoutUri") ?? "").trim();
        const frontchannelLogoutSessionRequired = fd.get("frontchannelLogoutSessionRequired") === "true";
        const backchannelLogoutSessionRequired = fd.get("backchannelLogoutSessionRequired") === "true";
        const scopesRaw = String(fd.get("scopes") ?? "openid").trim();
        const tokenMethodRaw = String(fd.get("tokenEndpointAuthMethod") ?? "client_secret_basic");
        if (!(ALLOWED_TOKEN_AUTH_METHODS as readonly string[]).includes(tokenMethodRaw)) {
            return fail(400, { create: true, error: "tokenEndpointAuthMethod 값이 올바르지 않습니다." });
        }
        const tokenMethod = tokenMethodRaw as TokenAuthMethod;
        // public client(none)는 PKCE 필수
        const requirePkce = tokenMethod === "none" ? true : fd.get("requirePkce") === "true";

        if (!name) return fail(400, { create: true, error: "이름은 필수입니다." });
        if (!redirectUrisRaw) return fail(400, { create: true, error: "Redirect URI 는 필수입니다." });

        // URL 검증
        const redirectV = validateUriList(redirectUrisRaw, "Redirect URI", { allowCustomScheme: true });
        if (!redirectV.ok) return fail(400, { create: true, error: redirectV.reason });
        const postLogoutV = postLogoutUrisRaw ? validateUriList(postLogoutUrisRaw, "Post-Logout Redirect URI") : null;
        if (postLogoutV && !postLogoutV.ok) return fail(400, { create: true, error: postLogoutV.reason });
        const frontV = validateSingleUri(frontchannelLogoutUri, "Frontchannel Logout URI");
        if (!frontV.ok) return fail(400, { create: true, error: frontV.reason });
        const backV = validateSingleUri(backchannelLogoutUri, "Backchannel Logout URI");
        if (!backV.ok) return fail(400, { create: true, error: backV.reason });

        const scopesV = normalizeScopes(scopesRaw);
        if (!scopesV.ok) return fail(400, { create: true, error: scopesV.reason });

        const clientId = generateClientId();
        const clientSecret = tokenMethod !== "none" ? generateClientSecret() : null;
        const clientSecretHashed = clientSecret ? await hashPassword(clientSecret) : null;

        await db.insert(oidcClients).values({
            id: crypto.randomUUID(),
            tenantId: tenant.id,
            clientId,
            clientSecretHash: clientSecretHashed,
            name,
            redirectUris: redirectV.json,
            postLogoutRedirectUris: postLogoutV ? postLogoutV.json : null,
            frontchannelLogoutUri: frontchannelLogoutUri || null,
            frontchannelLogoutSessionRequired,
            backchannelLogoutUri: backchannelLogoutUri || null,
            backchannelLogoutSessionRequired,
            scopes: scopesV.value,
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
        const frontchannelLogoutUri = String(fd.get("frontchannelLogoutUri") ?? "").trim();
        const backchannelLogoutUri = String(fd.get("backchannelLogoutUri") ?? "").trim();
        const frontchannelLogoutSessionRequired = fd.get("frontchannelLogoutSessionRequired") === "true";
        const backchannelLogoutSessionRequired = fd.get("backchannelLogoutSessionRequired") === "true";
        const scopesRaw = String(fd.get("scopes") ?? "openid").trim();
        const enabled = fd.get("enabled") === "true";

        if (!id || !name) return fail(400, { error: "잘못된 요청입니다." });
        if (!redirectUrisRaw) return fail(400, { error: "Redirect URI 는 필수입니다." });

        const redirectV = validateUriList(redirectUrisRaw, "Redirect URI", { allowCustomScheme: true });
        if (!redirectV.ok) return fail(400, { error: redirectV.reason });
        const postLogoutV = postLogoutUrisRaw ? validateUriList(postLogoutUrisRaw, "Post-Logout Redirect URI") : null;
        if (postLogoutV && !postLogoutV.ok) return fail(400, { error: postLogoutV.reason });
        const frontV = validateSingleUri(frontchannelLogoutUri, "Frontchannel Logout URI");
        if (!frontV.ok) return fail(400, { error: frontV.reason });
        const backV = validateSingleUri(backchannelLogoutUri, "Backchannel Logout URI");
        if (!backV.ok) return fail(400, { error: backV.reason });
        const scopesV = normalizeScopes(scopesRaw);
        if (!scopesV.ok) return fail(400, { error: scopesV.reason });

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
                redirectUris: redirectV.json,
                postLogoutRedirectUris: postLogoutV ? postLogoutV.json : null,
                frontchannelLogoutUri: frontchannelLogoutUri || null,
                frontchannelLogoutSessionRequired,
                backchannelLogoutUri: backchannelLogoutUri || null,
                backchannelLogoutSessionRequired,
                scopes: scopesV.value,
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

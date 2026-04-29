import type { DB } from "$lib/server/db";
import { clientSkins } from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";

const R2_PREFIX = "skins/";

const BLOCKED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

export function escapeHtml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function replacePlaceholders(html: string, vars: Record<string, string>): string {
    return html.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (_, key: string) => {
        return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : "";
    });
}

async function hashKey(input: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32);
}

function isFetchUrlAllowed(rawUrl: string): URL | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host)) return null;
    if (host.endsWith(".local")) return null;
    // IPv4 private/link-local 차단 (defense-in-depth)
    if (/^10\./.test(host)) return null;
    if (/^192\.168\./.test(host)) return null;
    if (/^169\.254\./.test(host)) return null;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return null;
    if (/^127\./.test(host)) return null;
    return url;
}

export async function resolveSkinHtml(
    db: DB,
    platform: App.Platform | undefined,
    tenantId: string,
    clientType: "oidc" | "saml",
    clientRefId: string,
    skinType: "login" | "signup" | "find_id" | "find_password" | "mfa" | "reset_password" = "login",
): Promise<string | null> {
    const [skin] = await db
        .select()
        .from(clientSkins)
        .where(
            and(
                eq(clientSkins.tenantId, tenantId),
                eq(clientSkins.clientType, clientType),
                eq(clientSkins.clientRefId, clientRefId),
                eq(clientSkins.skinType, skinType),
                eq(clientSkins.enabled, true),
            ),
        )
        .limit(1);

    if (!skin) return null;

    const r2 = (platform?.env as Record<string, unknown> | undefined)?.SKIN_CACHE as R2Bucket | undefined;
    const cacheKey = `${R2_PREFIX}${tenantId}/${clientType}/${await hashKey(clientRefId)}/${skinType}`;

    if (r2) {
        try {
            const cached = await r2.get(cacheKey);
            if (cached) {
                const fetchedAt = Number(cached.customMetadata?.fetchedAt ?? 0);
                if (Date.now() - fetchedAt < skin.cacheTtlSeconds * 1000) {
                    return await cached.text();
                }
            }
        } catch {
            // R2 오류는 무시하고 원본 fetch로 진행
        }
    }

    try {
        const fetchUrl = isFetchUrlAllowed(skin.fetchUrl);
        if (!fetchUrl) return null;

        const headers: Record<string, string> = { Accept: "text/html" };
        if (skin.fetchSecret) {
            headers["X-IDP-Token"] = skin.fetchSecret;
        }

        // redirect: "manual" — secret leak via 3xx Location 방지
        const res = await fetch(fetchUrl.toString(), { headers, redirect: "manual" });
        if (res.status >= 300 && res.status < 400) return null;
        if (!res.ok) return null;

        const contentType = res.headers.get("Content-Type") ?? "";
        if (!contentType.includes("text/html")) return null;

        const html = await res.text();

        if (r2) {
            try {
                await r2.put(cacheKey, html, {
                    customMetadata: { fetchedAt: String(Date.now()) },
                    httpMetadata: { contentType: "text/html; charset=utf-8" },
                });
            } catch {
                // 캐시 저장 실패는 무시
            }
        }

        return html;
    } catch {
        return null;
    }
}

export async function invalidateSkinCache(
    platform: App.Platform | undefined,
    tenantId: string,
    clientType: "oidc" | "saml",
    clientRefId: string,
    skinType: "login" | "signup" | "find_id" | "find_password" | "mfa" | "reset_password" = "login",
): Promise<void> {
    const r2 = (platform?.env as Record<string, unknown> | undefined)?.SKIN_CACHE as R2Bucket | undefined;
    if (!r2) return;
    const cacheKey = `${R2_PREFIX}${tenantId}/${clientType}/${await hashKey(clientRefId)}/${skinType}`;
    try {
        await r2.delete(cacheKey);
    } catch {
        // 무시
    }
}

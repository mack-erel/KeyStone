import type { DB } from "$lib/server/db";
import { clientSkins } from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";

const R2_PREFIX = "skins/";

export function escapeHtml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function replacePlaceholders(html: string, vars: Record<string, string>): string {
    let result = html;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replaceAll(`{{${key}}}`, value);
    }
    return result;
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
    const cacheKey = `${R2_PREFIX}${tenantId}/${clientType}/${clientRefId}/${skinType}`;

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
        const headers: Record<string, string> = { Accept: "text/html" };
        if (skin.fetchSecret) {
            headers["X-IDP-Token"] = skin.fetchSecret;
        }

        const res = await fetch(skin.fetchUrl, { headers });
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
    const cacheKey = `${R2_PREFIX}${tenantId}/${clientType}/${clientRefId}/${skinType}`;
    try {
        await r2.delete(cacheKey);
    } catch {
        // 무시
    }
}

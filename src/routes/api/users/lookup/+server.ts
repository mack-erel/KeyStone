import { error, json, type RequestHandler } from "@sveltejs/kit";
import { eq, and } from "drizzle-orm";
import { requireServiceToken } from "$lib/server/auth/service-token";
import { requireDbContext } from "$lib/server/auth/guards";
import { users, tenants } from "$lib/server/db/schema";
import { DEFAULT_TENANT_SLUG } from "$lib/server/auth/constants";

/**
 * Service-to-service user lookup.
 *
 * 신뢰된 다른 서비스 (예: stardust dispatcher) 가 username/email → users.id (uuid)
 * 매핑이 필요할 때 호출. Bearer service-token 으로 보호.
 *
 * Query 파라미터 (셋 중 하나):
 *   - `?id=<uuid>`                  : 직접 user id (tenant 무관)
 *   - `?username=<u>&tenant=<slug>` : tenant 슬러그 생략 시 default
 *   - `?email=<e>&tenant=<slug>`    : email 매칭 (lowercase 비교)
 *
 * 응답: `{ id, tenantId, username, email, displayName, role, status }`
 *       또는 404.
 */
export const GET: RequestHandler = async ({ request, url, locals }) => {
    requireServiceToken(request, locals.runtimeConfig);
    const { db } = requireDbContext(locals);

    const id = url.searchParams.get("id")?.trim();
    const username = url.searchParams.get("username")?.trim();
    const email = url.searchParams.get("email")?.trim()?.toLowerCase();
    const tenantSlug = url.searchParams.get("tenant")?.trim() ?? DEFAULT_TENANT_SLUG;

    if (!id && !username && !email) {
        throw error(400, "one of id / username / email required");
    }

    if (id) {
        const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
        if (!row) throw error(404, "user not found");
        return json(shape(row));
    }

    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, tenantSlug)).limit(1);
    if (!tenant) throw error(404, `tenant not found: ${tenantSlug}`);

    if (username) {
        const [row] = await db
            .select()
            .from(users)
            .where(and(eq(users.tenantId, tenant.id), eq(users.username, normalizeUsername(username))))
            .limit(1);
        if (!row) throw error(404, "user not found");
        return json(shape(row));
    }

    if (email) {
        const [row] = await db
            .select()
            .from(users)
            .where(and(eq(users.tenantId, tenant.id), eq(users.email, email)))
            .limit(1);
        if (!row) throw error(404, "user not found");
        return json(shape(row));
    }

    throw error(400, "no valid lookup param");
};

function normalizeUsername(u: string): string {
    return u.trim().toLowerCase();
}

function shape(row: typeof users.$inferSelect) {
    return {
        id: row.id,
        tenantId: row.tenantId,
        username: row.username,
        email: row.email,
        displayName: row.displayName,
        role: row.role,
        status: row.status,
    };
}

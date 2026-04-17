import { count, eq } from "drizzle-orm";
import type { PageServerLoad } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import {
    auditEvents,
    departments,
    oidcClients,
    positions,
    samlSps,
    signingKeys,
    teams,
    users,
} from "$lib/server/db/schema";

export const load: PageServerLoad = async ({ locals }) => {
    const { db, tenant } = requireDbContext(locals);
    const [
        userCount,
        oidcClientCount,
        samlSpCount,
        signingKeyCount,
        auditEventCount,
        deptCount,
        teamCount,
        positionCount,
    ] = await Promise.all([
        db.select({ count: count() }).from(users).where(eq(users.tenantId, tenant.id)),
        db.select({ count: count() }).from(oidcClients).where(eq(oidcClients.tenantId, tenant.id)),
        db.select({ count: count() }).from(samlSps).where(eq(samlSps.tenantId, tenant.id)),
        db.select({ count: count() }).from(signingKeys).where(eq(signingKeys.tenantId, tenant.id)),
        db.select({ count: count() }).from(auditEvents).where(eq(auditEvents.tenantId, tenant.id)),
        db.select({ count: count() }).from(departments).where(eq(departments.tenantId, tenant.id)),
        db.select({ count: count() }).from(teams).where(eq(teams.tenantId, tenant.id)),
        db.select({ count: count() }).from(positions).where(eq(positions.tenantId, tenant.id)),
    ]);

    return {
        counts: {
            users: userCount[0]?.count ?? 0,
            oidcClients: oidcClientCount[0]?.count ?? 0,
            samlSps: samlSpCount[0]?.count ?? 0,
            signingKeys: signingKeyCount[0]?.count ?? 0,
            auditEvents: auditEventCount[0]?.count ?? 0,
            departments: deptCount[0]?.count ?? 0,
            teams: teamCount[0]?.count ?? 0,
            positions: positionCount[0]?.count ?? 0,
        },
    };
};

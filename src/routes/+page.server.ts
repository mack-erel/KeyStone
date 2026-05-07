import { redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { PageServerLoad } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { credentials } from "$lib/server/db/schema";
import { TOTP_CREDENTIAL_TYPE, BACKUP_CODE_CREDENTIAL_TYPE, WEBAUTHN_CREDENTIAL_TYPE } from "$lib/server/auth/constants";

export const load: PageServerLoad = async ({ locals }) => {
    if (!locals.user) {
        throw redirect(303, "/login");
    }
    const { db } = requireDbContext(locals);
    const userId = locals.user.id;

    const userCredentials = await db.select({ id: credentials.id, type: credentials.type, usedAt: credentials.usedAt }).from(credentials).where(eq(credentials.userId, userId));

    const totpCount = userCredentials.filter((c) => c.type === TOTP_CREDENTIAL_TYPE).length;
    const webauthnCount = userCredentials.filter((c) => c.type === WEBAUTHN_CREDENTIAL_TYPE).length;
    // backup_code 는 1회 사용 — usedAt=null 이 남은 코드.
    const backupCodesRemaining = userCredentials.filter((c) => c.type === BACKUP_CODE_CREDENTIAL_TYPE && c.usedAt === null).length;

    return {
        viewer: {
            id: locals.user.id,
            email: locals.user.email,
            username: locals.user.username,
            displayName: locals.user.displayName,
            avatarUrl: locals.user.avatarUrl,
            role: locals.user.role,
        },
        security: {
            totpCount,
            webauthnCount,
            backupCodesRemaining,
            mfaEnabled: totpCount > 0 || webauthnCount > 0,
        },
    };
};

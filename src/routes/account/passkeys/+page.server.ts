import { fail, redirect } from "@sveltejs/kit";
import { eq, and } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import { credentials } from "$lib/server/db/schema";
import { WEBAUTHN_CREDENTIAL_TYPE } from "$lib/server/auth/constants";
import { findPasswordCredential } from "$lib/server/auth/users";
import { verifyPassword } from "$lib/server/auth/password";

export const load: PageServerLoad = async ({ locals, url }) => {
    if (!locals.user) {
        throw redirect(303, `/login?redirectTo=${encodeURIComponent(url.pathname)}`);
    }

    const { db } = requireDbContext(locals);

    const passkeys = await db
        .select({
            id: credentials.id,
            label: credentials.label,
            createdAt: credentials.createdAt,
            lastUsedAt: credentials.lastUsedAt,
            transports: credentials.transports,
        })
        .from(credentials)
        .where(and(eq(credentials.userId, locals.user.id), eq(credentials.type, WEBAUTHN_CREDENTIAL_TYPE)));

    return {
        passkeys,
        user: { email: locals.user.email, displayName: locals.user.displayName },
    };
};

export const actions: Actions = {
    delete: async (event) => {
        const { locals } = event;
        if (!locals.user) throw redirect(303, "/login");

        const formData = await event.request.formData();
        const credentialId = String(formData.get("id") ?? "").trim();
        const password = String(formData.get("password") ?? "");
        if (!credentialId) {
            return fail(400, { error: "삭제할 패스키를 지정해 주세요." });
        }

        const { db, tenant } = requireDbContext(locals);

        // ctrls H-AUTH-5: 세션 탈취 공격자가 가장 먼저 정당한 소유자의 패스키를
        // 삭제해 복구를 방해하는 시나리오를 차단하기 위해 step-up 재인증 강제.
        // 패스워드 credential 이 있는 사용자는 비밀번호 재입력 필수, 패스키-only
        // 사용자는 추가 보호 없이 진행 (passkey-only 의 경우 다른 step-up 방안은
        // 별도 PR — TOTP 또는 다른 passkey 챌린지).
        const pwCred = await findPasswordCredential(db, locals.user.id);
        if (pwCred?.secret) {
            if (!password) {
                return fail(401, { error: "본인 확인을 위해 비밀번호를 입력해 주세요." });
            }
            const ok = await verifyPassword(password, pwCred.secret);
            if (!ok.valid) {
                const requestMetadata = getRequestMetadata(event);
                await recordAuditEvent(db, {
                    tenantId: tenant.id,
                    userId: locals.user.id,
                    actorId: locals.user.id,
                    kind: "passkey_delete_password_failed",
                    outcome: "failure",
                    ip: requestMetadata.ip,
                    userAgent: requestMetadata.userAgent,
                });
                return fail(401, { error: "비밀번호가 일치하지 않습니다." });
            }
        }

        // 본인 소유 확인 후 삭제
        const deleted = await db.delete(credentials).where(and(eq(credentials.id, credentialId), eq(credentials.userId, locals.user.id), eq(credentials.type, WEBAUTHN_CREDENTIAL_TYPE)));

        if (!deleted) {
            return fail(404, { error: "패스키를 찾을 수 없습니다." });
        }

        const requestMetadata = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: locals.user.id,
            actorId: locals.user.id,
            kind: "passkey_deleted",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
        });

        return { deleted: true };
    },
};

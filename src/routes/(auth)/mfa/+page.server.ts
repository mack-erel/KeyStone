import { fail, redirect } from "@sveltejs/kit";
import { eq, and, isNull } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { getRequestMetadata, recordAuditEvent } from "$lib/server/audit";
import { requireDbContext } from "$lib/server/auth/guards";
import { createSessionRecord, revokeOtherSessions, setSessionCookie } from "$lib/server/auth/session";
import { verifyMfaPendingToken, MFA_PENDING_COOKIE } from "$lib/server/auth/mfa";
import { verifyTotp, decryptTotpSecret, encryptTotpSecret, isLegacyTotpCiphertext, verifyBackupCode } from "$lib/server/auth/totp";
import { checkRateLimit } from "$lib/server/ratelimit";
import { AMR_PASSWORD, AMR_TOTP, AMR_BACKUP_CODE, amrToAcr, TOTP_CREDENTIAL_TYPE, BACKUP_CODE_CREDENTIAL_TYPE } from "$lib/server/auth/constants";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { credentials, users } from "$lib/server/db/schema";
import { resolveSkinHtml, replacePlaceholders, escapeHtml } from "$lib/server/skin/resolver";

export const load: PageServerLoad = async ({ locals, cookies, platform, url }) => {
    const mfaToken = cookies.get(MFA_PENDING_COOKIE);

    // MFA pending 토큰이 없는 경우에만 자동 리다이렉트.
    // 토큰이 있으면 forceAuthn 등으로 재인증 중인 상태이므로 기존 세션을 무시한다.
    if (locals.user && !mfaToken) {
        throw redirect(302, locals.user.role === "admin" ? "/admin" : "/");
    }
    if (!mfaToken) {
        throw redirect(303, "/login");
    }

    const config = getRuntimeConfig(platform);
    if (!config.signingKeySecret) {
        throw redirect(303, "/login");
    }

    const claims = await verifyMfaPendingToken(mfaToken, config.signingKeySecret);
    if (!claims) {
        cookies.delete(MFA_PENDING_COOKIE, { path: "/" });
        throw redirect(303, "/login");
    }

    const skinHint = url.searchParams.get("skinHint");
    let skinHtml: string | null = null;

    if (skinHint && locals.db && locals.tenant) {
        const colonIdx = skinHint.indexOf(":");
        if (colonIdx > 0) {
            const clientType = skinHint.slice(0, colonIdx) as "oidc" | "saml";
            const clientRefId = skinHint.slice(colonIdx + 1);
            if ((clientType === "oidc" || clientType === "saml") && clientRefId) {
                const raw = await resolveSkinHtml(locals.db, platform, locals.tenant.id, clientType, clientRefId, "mfa");
                if (raw) {
                    skinHtml = replacePlaceholders(raw, {
                        IDP_FORM_ACTION: "",
                        IDP_SKIN_HINT: escapeHtml(skinHint),
                        IDP_REDIRECT_TO: "",
                        IDP_FLASH_MSG: "",
                    });
                }
            }
        }
    }

    return { skinHtml, skinHint, redirectTo: claims.redirectTo ?? null };
};

async function resolveMfaSkinForAction(event: Parameters<Actions["default"]>[0], flashMsg: string): Promise<string | null> {
    const skinHint = event.url.searchParams.get("skinHint");
    if (!skinHint || !event.locals.db || !event.locals.tenant) return null;
    const colonIdx = skinHint.indexOf(":");
    if (colonIdx <= 0) return null;
    const clientType = skinHint.slice(0, colonIdx) as "oidc" | "saml";
    const clientRefId = skinHint.slice(colonIdx + 1);
    if ((clientType !== "oidc" && clientType !== "saml") || !clientRefId) return null;
    const raw = await resolveSkinHtml(event.locals.db, event.platform, event.locals.tenant.id, clientType, clientRefId, "mfa");
    if (!raw) return null;
    return replacePlaceholders(raw, {
        IDP_FORM_ACTION: "",
        IDP_SKIN_HINT: escapeHtml(skinHint),
        IDP_REDIRECT_TO: "",
        IDP_FLASH_MSG: escapeHtml(flashMsg),
    });
}

export const actions: Actions = {
    default: async (event) => {
        const mfaToken = event.cookies.get(MFA_PENDING_COOKIE);
        if (!mfaToken) {
            throw redirect(303, "/login");
        }

        const config = getRuntimeConfig(event.platform);
        if (!config.signingKeySecret) {
            return fail(503, { error: "MFA 설정 오류가 발생했습니다.", skinHtml: await resolveMfaSkinForAction(event, "MFA 설정 오류가 발생했습니다.") });
        }

        const claims = await verifyMfaPendingToken(mfaToken, config.signingKeySecret);
        if (!claims) {
            event.cookies.delete(MFA_PENDING_COOKIE, { path: "/" });
            throw redirect(303, "/login");
        }

        const requestMetadata = getRequestMetadata(event);

        // IP 바인딩 검증: MFA 토큰 발급 IP 와 현재 요청 IP 가 다르면 거부
        if (claims.ip && claims.ip !== requestMetadata.ip) {
            event.cookies.delete(MFA_PENDING_COOKIE, { path: "/" });
            throw redirect(303, "/login");
        }

        if (!event.locals.db) {
            const msg = "DB가 준비되지 않았습니다.";
            return fail(503, { error: msg, skinHtml: await resolveMfaSkinForAction(event, msg) });
        }

        const rl = await checkRateLimit(event.locals.db, `mfa:${claims.userId}`, {
            windowMs: 5 * 60 * 1000,
            limit: 10,
        });
        if (!rl.allowed) {
            const msg = "MFA 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.";
            return fail(429, { error: msg, skinHtml: await resolveMfaSkinForAction(event, msg) });
        }

        const formData = await event.request.formData();
        const code = String(formData.get("code") ?? "")
            .trim()
            .replace(/\s/g, "");
        const useBackup = formData.get("use_backup") === "1";

        if (!code) {
            const msg = "인증 코드를 입력해 주세요.";
            return fail(400, { error: msg, skinHtml: await resolveMfaSkinForAction(event, msg) });
        }

        const { db } = requireDbContext(event.locals);

        // 사용자 확인
        const [user] = await db.select().from(users).where(eq(users.id, claims.userId)).limit(1);

        if (!user || user.status !== "active" || user.tenantId !== claims.tenantId) {
            event.cookies.delete(MFA_PENDING_COOKIE, { path: "/" });
            throw redirect(303, "/login");
        }

        let amrMethod: string = AMR_TOTP;
        let verified = false;

        if (useBackup) {
            // 백업 코드 검증: 미사용 backup_code credential 중 일치하는 것 찾기
            const backupCreds = await db
                .select()
                .from(credentials)
                .where(and(eq(credentials.userId, user.id), eq(credentials.type, BACKUP_CODE_CREDENTIAL_TYPE), isNull(credentials.usedAt)));

            for (const cred of backupCreds) {
                if (!cred.secret) continue;
                const match = await verifyBackupCode(code, cred.secret);
                if (match) {
                    // 소진 처리
                    await db.update(credentials).set({ usedAt: new Date() }).where(eq(credentials.id, cred.id));
                    amrMethod = AMR_BACKUP_CODE;
                    verified = true;
                    break;
                }
            }
        } else {
            // TOTP 검증
            const [totpCred] = await db
                .select()
                .from(credentials)
                .where(and(eq(credentials.userId, user.id), eq(credentials.type, TOTP_CREDENTIAL_TYPE)))
                .limit(1);

            if (totpCred?.secret) {
                const plainSecret = await decryptTotpSecret(totpCred.secret, config.signingKeySecret, user.id);
                // counter 컬럼을 마지막으로 사용된 TOTP 스텝으로 활용 (재사용 방지)
                const lastUsedStep = totpCred.counter ?? undefined;
                const matchedStep = await verifyTotp(code, plainSecret, lastUsedStep);
                if (matchedStep !== null) {
                    verified = true;
                    // v1 형식이면 v2 로 lazy migration.
                    let nextSecret = totpCred.secret;
                    if (isLegacyTotpCiphertext(totpCred.secret)) {
                        try {
                            nextSecret = await encryptTotpSecret(plainSecret, config.signingKeySecret, user.id);
                        } catch {
                            nextSecret = totpCred.secret;
                        }
                    }
                    await db
                        .update(credentials)
                        .set({ lastUsedAt: new Date(), counter: matchedStep, secret: nextSecret })
                        .where(eq(credentials.id, totpCred.id));
                }
            }
        }

        if (!verified) {
            await recordAuditEvent(db, {
                tenantId: claims.tenantId,
                userId: user.id,
                actorId: user.id,
                kind: "mfa_verify",
                outcome: "failure",
                ip: requestMetadata.ip,
                userAgent: requestMetadata.userAgent,
                detail: { method: useBackup ? "backup_code" : "totp" },
            });

            const msg = useBackup ? "백업 코드가 올바르지 않거나 이미 사용되었습니다." : "인증 코드가 올바르지 않습니다. 시간이 맞는지 확인해 주세요.";
            return fail(400, { error: msg, skinHtml: await resolveMfaSkinForAction(event, msg) });
        }

        // MFA 통과 — 세션 생성
        event.cookies.delete(MFA_PENDING_COOKIE, { path: "/" });

        const { sessionToken, expiresAt, sessionId } = await createSessionRecord(db, {
            tenantId: claims.tenantId,
            userId: user.id,
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            amr: [AMR_PASSWORD, amrMethod],
            acr: amrToAcr([AMR_PASSWORD, amrMethod]),
        });

        // 기존 세션 회수 — 새 세션만 살아남도록.
        await revokeOtherSessions(db, user.id, sessionId);

        setSessionCookie(event.cookies, event.url, sessionToken, expiresAt);
        await recordAuditEvent(db, {
            tenantId: claims.tenantId,
            userId: user.id,
            actorId: user.id,
            kind: "login",
            outcome: "success",
            ip: requestMetadata.ip,
            userAgent: requestMetadata.userAgent,
            detail: { amr: [AMR_PASSWORD, amrMethod] },
        });

        const dest = claims.redirectTo;
        throw redirect(303, user.role === "admin" ? (dest ?? "/admin") : (dest ?? "/"));
    },
};

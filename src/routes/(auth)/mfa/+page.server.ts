import { fail, redirect } from '@sveltejs/kit';
import { eq, and, isNull } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { getRequestMetadata, recordAuditEvent } from '$lib/server/audit';
import { requireDbContext } from '$lib/server/auth/guards';
import { createSessionRecord, setSessionCookie } from '$lib/server/auth/session';
import { verifyMfaPendingToken, MFA_PENDING_COOKIE } from '$lib/server/auth/mfa';
import { verifyTotp, decryptTotpSecret, verifyBackupCode } from '$lib/server/auth/totp';
import {
	AMR_PASSWORD,
	AMR_TOTP,
	AMR_BACKUP_CODE,
	TOTP_CREDENTIAL_TYPE,
	BACKUP_CODE_CREDENTIAL_TYPE
} from '$lib/server/auth/constants';
import { getRuntimeConfig } from '$lib/server/auth/runtime';
import { credentials, users } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals, cookies, platform }) => {
	// 이미 로그인된 경우
	if (locals.user) {
		throw redirect(302, locals.user.role === 'admin' ? '/admin' : '/');
	}

	const mfaToken = cookies.get(MFA_PENDING_COOKIE);
	if (!mfaToken) {
		throw redirect(303, '/login');
	}

	const config = getRuntimeConfig(platform);
	if (!config.signingKeySecret) {
		throw redirect(303, '/login');
	}

	const claims = await verifyMfaPendingToken(mfaToken, config.signingKeySecret);
	if (!claims) {
		cookies.delete(MFA_PENDING_COOKIE, { path: '/' });
		throw redirect(303, '/login');
	}

	return {};
};

export const actions: Actions = {
	default: async (event) => {
		const mfaToken = event.cookies.get(MFA_PENDING_COOKIE);
		if (!mfaToken) {
			throw redirect(303, '/login');
		}

		const config = getRuntimeConfig(event.platform);
		if (!config.signingKeySecret) {
			return fail(503, { error: 'MFA 설정 오류가 발생했습니다.' });
		}

		const claims = await verifyMfaPendingToken(mfaToken, config.signingKeySecret);
		if (!claims) {
			event.cookies.delete(MFA_PENDING_COOKIE, { path: '/' });
			throw redirect(303, '/login');
		}

		const formData = await event.request.formData();
		const code = String(formData.get('code') ?? '')
			.trim()
			.replace(/\s/g, '');
		const useBackup = formData.get('use_backup') === '1';

		if (!code) {
			return fail(400, { error: '인증 코드를 입력해 주세요.' });
		}

		if (!event.locals.db) {
			return fail(503, { error: 'DB가 준비되지 않았습니다.' });
		}

		const { db } = requireDbContext(event.locals);
		const requestMetadata = getRequestMetadata(event);

		// 사용자 확인
		const [user] = await db.select().from(users).where(eq(users.id, claims.userId)).limit(1);

		if (!user || user.status !== 'active' || user.tenantId !== claims.tenantId) {
			event.cookies.delete(MFA_PENDING_COOKIE, { path: '/' });
			throw redirect(303, '/login');
		}

		let amrMethod: string = AMR_TOTP;
		let verified = false;

		if (useBackup) {
			// 백업 코드 검증: 미사용 backup_code credential 중 일치하는 것 찾기
			const backupCreds = await db
				.select()
				.from(credentials)
				.where(
					and(
						eq(credentials.userId, user.id),
						eq(credentials.type, BACKUP_CODE_CREDENTIAL_TYPE),
						isNull(credentials.usedAt)
					)
				);

			for (const cred of backupCreds) {
				if (!cred.secret) continue;
				const match = await verifyBackupCode(code, cred.secret);
				if (match) {
					// 소진 처리
					await db
						.update(credentials)
						.set({ usedAt: new Date() })
						.where(eq(credentials.id, cred.id));
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
				const plainSecret = await decryptTotpSecret(totpCred.secret, config.signingKeySecret);
				verified = await verifyTotp(code, plainSecret);
				if (verified) {
					await db
						.update(credentials)
						.set({ lastUsedAt: new Date() })
						.where(eq(credentials.id, totpCred.id));
				}
			}
		}

		if (!verified) {
			await recordAuditEvent(db, {
				tenantId: claims.tenantId,
				userId: user.id,
				actorId: user.id,
				kind: 'mfa_verify',
				outcome: 'failure',
				ip: requestMetadata.ip,
				userAgent: requestMetadata.userAgent,
				detail: { method: useBackup ? 'backup_code' : 'totp' }
			});

			return fail(400, {
				error: useBackup
					? '백업 코드가 올바르지 않거나 이미 사용되었습니다.'
					: '인증 코드가 올바르지 않습니다. 시간이 맞는지 확인해 주세요.'
			});
		}

		// MFA 통과 — 세션 생성
		event.cookies.delete(MFA_PENDING_COOKIE, { path: '/' });

		const { sessionToken, expiresAt } = await createSessionRecord(db, {
			tenantId: claims.tenantId,
			userId: user.id,
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent,
			amr: [AMR_PASSWORD, amrMethod]
		});

		setSessionCookie(event.cookies, event.url, sessionToken, expiresAt);
		await recordAuditEvent(db, {
			tenantId: claims.tenantId,
			userId: user.id,
			actorId: user.id,
			kind: 'login',
			outcome: 'success',
			ip: requestMetadata.ip,
			userAgent: requestMetadata.userAgent,
			detail: { amr: [AMR_PASSWORD, amrMethod] }
		});

		const dest = claims.redirectTo;
		throw redirect(303, user.role === 'admin' ? (dest ?? '/admin') : (dest ?? '/'));
	}
};

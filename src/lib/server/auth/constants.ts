export const DEFAULT_TENANT_SLUG = 'default';
export const SESSION_COOKIE_NAME = 'idp_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
export const SESSION_TOUCH_INTERVAL_MS = 1000 * 60 * 5;
export const PASSWORD_CREDENTIAL_TYPE = 'password';
export const LOCAL_IDENTITY_PROVIDER = 'local';

// MFA credential 타입
export const TOTP_CREDENTIAL_TYPE = 'totp';
export const BACKUP_CODE_CREDENTIAL_TYPE = 'backup_code';

// AMR (Authentication Methods References) 값
export const AMR_PASSWORD = 'pwd';
export const AMR_TOTP = 'totp';
export const AMR_BACKUP_CODE = 'swk'; // software key (RFC 8176 유사)
export const AMR_WEBAUTHN = 'hwk'; // hardware key (RFC 8176)

// WebAuthn credential 타입
export const WEBAUTHN_CREDENTIAL_TYPE = 'webauthn';

// ACR (Authentication Context Class Reference) 값
export const ACR_PASSWORD_TRANSPORT = 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';
export const ACR_MFA = 'https://refeds.org/profile/mfa';

/** AMR 배열로부터 ACR 을 결정한다. */
export function amrToAcr(amr: string[]): string {
	if (amr.includes(AMR_WEBAUTHN) || (amr.includes(AMR_PASSWORD) && (amr.includes(AMR_TOTP) || amr.includes(AMR_BACKUP_CODE)))) {
		return ACR_MFA;
	}
	return ACR_PASSWORD_TRANSPORT;
}

/** ACR 강도 레벨 (숫자가 높을수록 강함) */
const ACR_LEVEL: Record<string, number> = {
	'urn:oasis:names:tc:SAML:2.0:ac:classes:Password': 1,
	[ACR_PASSWORD_TRANSPORT]: 1,
	[ACR_MFA]: 2,
};

function acrLevel(acr: string | null): number {
	return ACR_LEVEL[acr ?? ''] ?? 1;
}

/**
 * 상위 ACR 이 포함(subsume)하는 하위 ACR 목록.
 * refeds/mfa 로 인증한 사용자는 PasswordProtectedTransport 도 만족한다.
 */
const ACR_SUBSUMES: Record<string, string[]> = {
	[ACR_MFA]: [ACR_PASSWORD_TRANSPORT, 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password'],
};

function acrSubsumes(sessionAcr: string | null, requestedRef: string): boolean {
	if (!sessionAcr) return false;
	return ACR_SUBSUMES[sessionAcr]?.includes(requestedRef) ?? false;
}

/**
 * 세션 ACR 이 SP 가 요구하는 RequestedAuthnContext 를 만족하는지 검사한다.
 * comparison: exact | minimum | maximum | better
 */
export function acrSatisfies(sessionAcr: string | null, requested: { comparison: string; classRefs: string[] }): boolean {
	const level = acrLevel(sessionAcr);
	switch (requested.comparison) {
		case 'exact':
			// 정확히 일치하거나, 상위 ACR 이 해당 수준을 포함(subsume)하는 경우 허용
			return requested.classRefs.some((ref) => ref === sessionAcr || acrSubsumes(sessionAcr, ref));
		case 'minimum':
			return requested.classRefs.some((ref) => level >= acrLevel(ref));
		case 'maximum':
			return requested.classRefs.some((ref) => level <= acrLevel(ref));
		case 'better':
			return requested.classRefs.some((ref) => level > acrLevel(ref));
		default:
			return requested.classRefs.some((ref) => ref === sessionAcr || acrSubsumes(sessionAcr, ref));
	}
}

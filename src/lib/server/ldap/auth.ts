import { ldapBind, ldapFetchEntry, ldapSearchDn } from './client';
import type { LdapProviderConfig, LdapUserAttrs } from './types';

/**
 * LDAP 인증 + 속성 조회.
 *
 * - bindDN 설정 시: Admin bind → uid 검색으로 DN 확정 → 유저 bind (Search 방식)
 * - bindDN 미설정 시: userDnPattern 으로 DN 조합 → 유저 bind (Pattern 방식)
 *
 * 인증 실패 시 null 반환, 서버 오류는 throw.
 */
export async function authenticateLdap(
	config: LdapProviderConfig,
	username: string,
	password: string
): Promise<LdapUserAttrs | null> {
	let userDn: string;

	if (config.bindDN && config.bindPassword) {
		// Search 방식: admin bind → uid 검색으로 실제 DN 확정
		const filter = (config.userSearchFilter ?? '(uid={username})').replace(
			'{username}',
			username
		);
		const found = await ldapSearchDn(config, config.bindDN, config.bindPassword, filter);
		if (!found) return null; // 유저 없음
		userDn = found;
	} else {
		// Pattern 방식: userDnPattern 으로 DN 직접 조합
		if (!config.userDnPattern) return null;
		userDn = config.userDnPattern.replace('{username}', username);
	}

	// 유저 bind — 비밀번호 검증
	try {
		await ldapBind(config, userDn, password);
	} catch {
		return null;
	}

	// 속성 조회
	const attrMap = config.attributeMap ?? {};
	const emailAttr = attrMap.email ?? 'mail';
	const displayNameAttr = attrMap.displayName ?? 'cn';
	const givenNameAttr = attrMap.givenName ?? 'givenName';
	const familyNameAttr = attrMap.familyName ?? 'sn';

	let entry: Record<string, string> | null = null;
	try {
		entry = await ldapFetchEntry(config, userDn, password, userDn, [
			emailAttr,
			displayNameAttr,
			givenNameAttr,
			familyNameAttr
		]);
	} catch {
		// 속성 조회 실패해도 인증은 성공으로 처리
	}

	return {
		dn: userDn,
		username,
		email: entry?.[emailAttr] || `${username}@ldap.local`,
		displayName: entry?.[displayNameAttr] ?? null,
		givenName: entry?.[givenNameAttr] ?? null,
		familyName: entry?.[familyNameAttr] ?? null
	};
}

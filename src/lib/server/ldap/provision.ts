import { and, eq } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { identities, users, type User } from '$lib/server/db/schema';
import type { LdapUserAttrs } from './types';

/**
 * LDAP 인증 성공 후 D1에 유저를 JIT 프로비저닝한다.
 *
 * 우선순위:
 * 1. 기존 LDAP identity 연결 → 유저 정보 동기화 후 반환
 * 2. 같은 이메일의 로컬 유저 존재 → identity 연결 후 반환
 * 3. 완전 신규 → users + identities 생성
 */
export async function provisionLdapUser(
	db: DB,
	tenantId: string,
	providerId: string,
	attrs: LdapUserAttrs
): Promise<User> {
	const provider = `ldap:${providerId}`;

	// 1. 기존 LDAP identity 확인
	const [existingIdentity] = await db
		.select({ userId: identities.userId })
		.from(identities)
		.where(
			and(
				eq(identities.tenantId, tenantId),
				eq(identities.provider, provider),
				eq(identities.subject, attrs.dn)
			)
		)
		.limit(1);

	if (existingIdentity) {
		await db
			.update(users)
			.set({
				email: attrs.email,
				displayName: attrs.displayName,
				givenName: attrs.givenName,
				familyName: attrs.familyName,
				updatedAt: new Date()
			})
			.where(eq(users.id, existingIdentity.userId));

		await db
			.update(identities)
			.set({ email: attrs.email, lastLoginAt: new Date() })
			.where(
				and(
					eq(identities.tenantId, tenantId),
					eq(identities.provider, provider),
					eq(identities.subject, attrs.dn)
				)
			);

		const [user] = await db
			.select()
			.from(users)
			.where(and(eq(users.id, existingIdentity.userId), eq(users.status, 'active')))
			.limit(1);

		if (!user) throw new Error('LDAP 유저 계정이 비활성 상태입니다.');
		return user;
	}

	// 2. 동일 이메일 로컬 유저가 있을 경우 자동 연결하지 않음 (계정 탈취 방지)
	// LDAP 제공자가 이메일을 조작해 기존 계정(관리자 포함)을 하이재킹할 수 있으므로
	// 기존 로컬 계정과의 연결은 관리자가 직접 수행해야 한다.
	const [existingUser] = await db
		.select()
		.from(users)
		.where(
			and(eq(users.tenantId, tenantId), eq(users.email, attrs.email), eq(users.status, 'active'))
		)
		.limit(1);

	if (existingUser) {
		throw new Error(
			`이미 동일한 이메일(${attrs.email})의 로컬 계정이 존재합니다. ` +
				'LDAP 계정 연결은 관리자에게 문의하세요.'
		);
	}

	// 3. 완전 신규 유저 생성
	const userId = crypto.randomUUID();

	// username 중복 방지: 충돌 시 뒤에 랜덤 suffix
	let username = attrs.username;
	const [usernameConflict] = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.tenantId, tenantId), eq(users.username, username)))
		.limit(1);

	if (usernameConflict) {
		username = `${attrs.username}_${crypto.randomUUID().slice(0, 6)}`;
	}

	await db.insert(users).values({
		id: userId,
		tenantId,
		username,
		email: attrs.email,
		displayName: attrs.displayName,
		givenName: attrs.givenName,
		familyName: attrs.familyName,
		role: 'user',
		status: 'active'
	});

	await db.insert(identities).values({
		tenantId,
		userId,
		provider,
		subject: attrs.dn,
		email: attrs.email,
		rawProfileJson: JSON.stringify(attrs),
		lastLoginAt: new Date()
	});

	const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
	return user;
}

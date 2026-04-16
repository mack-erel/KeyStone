import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ---------- Tenancy ----------

export const tenants = sqliteTable(
	'tenants',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		status: text('status', { enum: ['active', 'suspended'] })
			.notNull()
			.default('active'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [uniqueIndex('tenants_slug_uidx').on(t.slug)]
);

// ---------- Directory ----------

export const users = sqliteTable(
	'users',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: text('tenant_id')
			.notNull()
			.references(() => tenants.id, { onDelete: 'cascade' }),
		username: text('username'),
		email: text('email').notNull(),
		emailVerifiedAt: integer('email_verified_at', { mode: 'timestamp_ms' }),
		displayName: text('display_name'),
		role: text('role', { enum: ['admin', 'user'] })
			.notNull()
			.default('user'),
		status: text('status', { enum: ['active', 'disabled', 'locked'] })
			.notNull()
			.default('active'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [
		uniqueIndex('users_tenant_email_uidx').on(t.tenantId, t.email),
		uniqueIndex('users_tenant_username_uidx').on(t.tenantId, t.username),
		index('users_tenant_idx').on(t.tenantId)
	]
);

/**
 * 인증 수단. 한 유저가 여러 credential 을 가질 수 있음 (password + TOTP + WebAuthn 복수).
 * - type='password': secret = pbkdf2/argon2id hash, publicKey=NULL
 * - type='totp': secret = encrypted TOTP seed, publicKey=NULL
 * - type='webauthn': secret=NULL, publicKey = CBOR-encoded COSE key, credentialId 별도, counter
 * - type='backup_code': secret = hash of one-time code, usedAt 로 소진 관리
 */
export const credentials = sqliteTable(
	'credentials',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		type: text('type', { enum: ['password', 'totp', 'webauthn', 'backup_code'] }).notNull(),
		label: text('label'),
		secret: text('secret'),
		publicKey: text('public_key'),
		credentialId: text('credential_id'),
		counter: integer('counter').notNull().default(0),
		transports: text('transports'),
		lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
		usedAt: integer('used_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [
		index('credentials_user_idx').on(t.userId),
		index('credentials_user_type_idx').on(t.userId, t.type),
		uniqueIndex('credentials_webauthn_credential_id_uidx').on(t.credentialId)
	]
);

/**
 * 인증 소스. MVP 는 provider='local' 만 사용. federation 추가 시 google/github/saml:<entity> 등으로 확장.
 * (tenantId, provider, subject) 는 unique — 같은 외부 IdP 의 같은 subject 가 중복되지 않도록.
 */
export const identities = sqliteTable(
	'identities',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: text('tenant_id')
			.notNull()
			.references(() => tenants.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		provider: text('provider').notNull(),
		subject: text('subject').notNull(),
		email: text('email'),
		rawProfileJson: text('raw_profile_json'),
		linkedAt: integer('linked_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' })
	},
	(t) => [
		uniqueIndex('identities_tenant_provider_subject_uidx').on(t.tenantId, t.provider, t.subject),
		index('identities_user_idx').on(t.userId)
	]
);

/**
 * MVP 에선 빈 테이블. federation 활성 시 테넌트별 IdP 설정을 행으로 추가.
 */
export const identityProviders = sqliteTable(
	'identity_providers',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: text('tenant_id')
			.notNull()
			.references(() => tenants.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: ['oidc', 'saml', 'oauth2'] }).notNull(),
		name: text('name').notNull(),
		clientId: text('client_id'),
		clientSecretEnc: text('client_secret_enc'),
		discoveryUrl: text('discovery_url'),
		metadataXml: text('metadata_xml'),
		scopes: text('scopes'),
		configJson: text('config_json'),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [
		index('idp_tenant_idx').on(t.tenantId),
		uniqueIndex('idp_tenant_name_uidx').on(t.tenantId, t.name)
	]
);

// ---------- Session ----------

/**
 * IdP 자체 SSO 세션. 브라우저 쿠키가 가리키는 단일 세션이며,
 * 이 아래에 oidc_grants / saml_sessions 가 묶인다.
 */
export const sessions = sqliteTable(
	'sessions',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: text('tenant_id')
			.notNull()
			.references(() => tenants.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** IdP-level session id, SAML SessionIndex / OIDC sid 로도 사용 */
		idpSessionId: text('idp_session_id').notNull(),
		amr: text('amr'),
		acr: text('acr'),
		ip: text('ip'),
		userAgent: text('user_agent'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
		revokedAt: integer('revoked_at', { mode: 'timestamp_ms' })
	},
	(t) => [
		uniqueIndex('sessions_idp_session_id_uidx').on(t.idpSessionId),
		index('sessions_user_idx').on(t.userId),
		index('sessions_expires_idx').on(t.expiresAt)
	]
);

// ---------- OIDC ----------

export const oidcClients = sqliteTable(
	'oidc_clients',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: text('tenant_id')
			.notNull()
			.references(() => tenants.id, { onDelete: 'cascade' }),
		clientId: text('client_id').notNull(),
		clientSecretHash: text('client_secret_hash'),
		name: text('name').notNull(),
		redirectUris: text('redirect_uris').notNull(),
		postLogoutRedirectUris: text('post_logout_redirect_uris'),
		scopes: text('scopes').notNull().default('openid'),
		grantTypes: text('grant_types').notNull().default('authorization_code,refresh_token'),
		responseTypes: text('response_types').notNull().default('code'),
		tokenEndpointAuthMethod: text('token_endpoint_auth_method', {
			enum: ['client_secret_basic', 'client_secret_post', 'none', 'private_key_jwt']
		})
			.notNull()
			.default('client_secret_basic'),
		requirePkce: integer('require_pkce', { mode: 'boolean' }).notNull().default(true),
		idTokenSignedResponseAlg: text('id_token_signed_response_alg').notNull().default('RS256'),
		jwksUri: text('jwks_uri'),
		jwks: text('jwks'),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [
		uniqueIndex('oidc_clients_tenant_client_id_uidx').on(t.tenantId, t.clientId),
		index('oidc_clients_tenant_idx').on(t.tenantId)
	]
);

export const oidcGrants = sqliteTable(
	'oidc_grants',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: text('tenant_id')
			.notNull()
			.references(() => tenants.id, { onDelete: 'cascade' }),
		clientId: text('client_id').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
		code: text('code').notNull(),
		codeChallenge: text('code_challenge'),
		codeChallengeMethod: text('code_challenge_method', { enum: ['S256', 'plain'] }),
		redirectUri: text('redirect_uri').notNull(),
		scope: text('scope').notNull(),
		nonce: text('nonce'),
		state: text('state'),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
		usedAt: integer('used_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [
		uniqueIndex('oidc_grants_code_uidx').on(t.code),
		index('oidc_grants_tenant_client_idx').on(t.tenantId, t.clientId),
		index('oidc_grants_expires_idx').on(t.expiresAt)
	]
);

export const oidcRefreshTokens = sqliteTable(
	'oidc_refresh_tokens',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: text('tenant_id')
			.notNull()
			.references(() => tenants.id, { onDelete: 'cascade' }),
		clientId: text('client_id').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
		tokenHash: text('token_hash').notNull(),
		scope: text('scope').notNull(),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
		revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
		replacedById: text('replaced_by_id'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [
		uniqueIndex('oidc_refresh_tokens_hash_uidx').on(t.tokenHash),
		index('oidc_refresh_tokens_user_idx').on(t.userId)
	]
);

// ---------- SAML ----------

export const samlSps = sqliteTable(
	'saml_sps',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: text('tenant_id')
			.notNull()
			.references(() => tenants.id, { onDelete: 'cascade' }),
		entityId: text('entity_id').notNull(),
		name: text('name').notNull(),
		acsUrl: text('acs_url').notNull(),
		acsBinding: text('acs_binding')
			.notNull()
			.default('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'),
		sloUrl: text('slo_url'),
		sloBinding: text('slo_binding'),
		cert: text('cert'),
		nameIdFormat: text('name_id_format')
			.notNull()
			.default('urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'),
		signAssertion: integer('sign_assertion', { mode: 'boolean' }).notNull().default(true),
		signResponse: integer('sign_response', { mode: 'boolean' }).notNull().default(false),
		encryptAssertion: integer('encrypt_assertion', { mode: 'boolean' }).notNull().default(false),
		wantAuthnRequestsSigned: integer('want_authn_requests_signed', { mode: 'boolean' })
			.notNull()
			.default(false),
		attributeMappingJson: text('attribute_mapping_json'),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [
		uniqueIndex('saml_sps_tenant_entity_id_uidx').on(t.tenantId, t.entityId),
		index('saml_sps_tenant_idx').on(t.tenantId)
	]
);

export const samlSessions = sqliteTable(
	'saml_sessions',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: text('tenant_id')
			.notNull()
			.references(() => tenants.id, { onDelete: 'cascade' }),
		spId: text('sp_id')
			.notNull()
			.references(() => samlSps.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
		sessionIndex: text('session_index').notNull(),
		nameId: text('name_id').notNull(),
		nameIdFormat: text('name_id_format'),
		notOnOrAfter: integer('not_on_or_after', { mode: 'timestamp_ms' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		endedAt: integer('ended_at', { mode: 'timestamp_ms' })
	},
	(t) => [
		uniqueIndex('saml_sessions_session_index_uidx').on(t.sessionIndex),
		index('saml_sessions_tenant_sp_idx').on(t.tenantId, t.spId)
	]
);

// ---------- Keys & Audit ----------

/**
 * 서명 키. 테넌트별 독립. kid 로 선택하며, rotation 시 active 는 한 번에 하나,
 * 구 키는 `rotatedAt` 이 설정된 채로 검증용으로 남는다.
 */
export const signingKeys = sqliteTable(
	'signing_keys',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: text('tenant_id')
			.notNull()
			.references(() => tenants.id, { onDelete: 'cascade' }),
		kid: text('kid').notNull(),
		use: text('use', { enum: ['sig', 'enc'] })
			.notNull()
			.default('sig'),
		alg: text('alg').notNull(),
		publicJwk: text('public_jwk').notNull(),
		privateJwkEncrypted: text('private_jwk_encrypted').notNull(),
		certPem: text('cert_pem'),
		active: integer('active', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		rotatedAt: integer('rotated_at', { mode: 'timestamp_ms' }),
		notAfter: integer('not_after', { mode: 'timestamp_ms' })
	},
	(t) => [
		uniqueIndex('signing_keys_tenant_kid_uidx').on(t.tenantId, t.kid),
		index('signing_keys_tenant_active_idx').on(t.tenantId, t.active)
	]
);

export const auditEvents = sqliteTable(
	'audit_events',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tenantId: text('tenant_id')
			.notNull()
			.references(() => tenants.id, { onDelete: 'cascade' }),
		userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
		actorId: text('actor_id'),
		spOrClientId: text('sp_or_client_id'),
		kind: text('kind').notNull(),
		outcome: text('outcome', { enum: ['success', 'failure'] }).notNull(),
		ip: text('ip'),
		userAgent: text('user_agent'),
		detailJson: text('detail_json'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(t) => [
		index('audit_events_tenant_kind_idx').on(t.tenantId, t.kind),
		index('audit_events_tenant_created_idx').on(t.tenantId, t.createdAt),
		index('audit_events_user_idx').on(t.userId)
	]
);

// ---------- Types ----------

export type Tenant = typeof tenants.$inferSelect;
// ---------- Rate Limits ----------

export const rateLimits = sqliteTable('rate_limits', {
	key: text('key').primaryKey(),
	count: integer('count').notNull().default(1),
	expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull()
});

export type User = typeof users.$inferSelect;
export type Credential = typeof credentials.$inferSelect;
export type Identity = typeof identities.$inferSelect;
export type IdentityProvider = typeof identityProviders.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type OidcClient = typeof oidcClients.$inferSelect;
export type OidcGrant = typeof oidcGrants.$inferSelect;
export type OidcRefreshToken = typeof oidcRefreshTokens.$inferSelect;
export type SamlSp = typeof samlSps.$inferSelect;
export type SamlSession = typeof samlSessions.$inferSelect;
export type SigningKey = typeof signingKeys.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;

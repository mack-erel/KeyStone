import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, integer, sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// ---------- Tenancy ----------

export const tenants = sqliteTable(
    "tenants",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        slug: text("slug").notNull(),
        name: text("name").notNull(),
        status: text("status", { enum: ["active", "suspended"] })
            .notNull()
            .default("active"),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [uniqueIndex("tenants_slug_uidx").on(t.slug)],
);

// ---------- Directory ----------

export const users = sqliteTable(
    "users",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        username: text("username"),
        email: text("email").notNull(),
        emailVerifiedAt: integer("email_verified_at", { mode: "timestamp_ms" }),
        displayName: text("display_name"),
        role: text("role", { enum: ["admin", "user"] })
            .notNull()
            .default("user"),
        status: text("status", { enum: ["active", "disabled", "locked"] })
            .notNull()
            .default("active"),
        // 프로필
        givenName: text("given_name"),
        familyName: text("family_name"),
        phoneNumber: text("phone_number"),
        phoneVerifiedAt: integer("phone_verified_at", { mode: "timestamp_ms" }),
        avatarUrl: text("avatar_url"),
        locale: text("locale").default("ko-KR"),
        zoneinfo: text("zoneinfo").default("Asia/Seoul"),
        bio: text("bio"),
        birthdate: text("birthdate"), // ISO 8601 날짜 문자열 (YYYY-MM-DD)
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [uniqueIndex("users_tenant_email_uidx").on(t.tenantId, t.email), uniqueIndex("users_tenant_username_uidx").on(t.tenantId, t.username), index("users_tenant_idx").on(t.tenantId)],
);

/**
 * 인증 수단. 한 유저가 여러 credential 을 가질 수 있음 (password + TOTP + WebAuthn 복수).
 * - type='password': secret = pbkdf2/argon2id hash, publicKey=NULL
 * - type='totp': secret = encrypted TOTP seed, publicKey=NULL
 * - type='webauthn': secret=NULL, publicKey = CBOR-encoded COSE key, credentialId 별도, counter
 * - type='backup_code': secret = hash of one-time code, usedAt 로 소진 관리
 */
export const credentials = sqliteTable(
    "credentials",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        type: text("type", { enum: ["password", "totp", "webauthn", "backup_code"] }).notNull(),
        label: text("label"),
        secret: text("secret"),
        publicKey: text("public_key"),
        credentialId: text("credential_id"),
        counter: integer("counter").notNull().default(0),
        transports: text("transports"),
        lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
        usedAt: integer("used_at", { mode: "timestamp_ms" }),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [index("credentials_user_idx").on(t.userId), index("credentials_user_type_idx").on(t.userId, t.type), uniqueIndex("credentials_webauthn_credential_id_uidx").on(t.credentialId)],
);

/**
 * 인증 소스. MVP 는 provider='local' 만 사용. federation 추가 시 google/github/saml:<entity> 등으로 확장.
 * (tenantId, provider, subject) 는 unique — 같은 외부 IdP 의 같은 subject 가 중복되지 않도록.
 */
export const identities = sqliteTable(
    "identities",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        provider: text("provider").notNull(),
        subject: text("subject").notNull(),
        email: text("email"),
        rawProfileJson: text("raw_profile_json"),
        linkedAt: integer("linked_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    },
    (t) => [uniqueIndex("identities_tenant_provider_subject_uidx").on(t.tenantId, t.provider, t.subject), index("identities_user_idx").on(t.userId)],
);

/**
 * MVP 에선 빈 테이블. federation 활성 시 테넌트별 IdP 설정을 행으로 추가.
 */
export const identityProviders = sqliteTable(
    "identity_providers",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        kind: text("kind", { enum: ["oidc", "saml", "oauth2", "ldap"] }).notNull(),
        name: text("name").notNull(),
        clientId: text("client_id"),
        clientSecretEnc: text("client_secret_enc"),
        discoveryUrl: text("discovery_url"),
        metadataXml: text("metadata_xml"),
        scopes: text("scopes"),
        configJson: text("config_json"),
        enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [index("idp_tenant_idx").on(t.tenantId), uniqueIndex("idp_tenant_name_uidx").on(t.tenantId, t.name)],
);

// ---------- Session ----------

/**
 * IdP 자체 SSO 세션. 브라우저 쿠키가 가리키는 단일 세션이며,
 * 이 아래에 oidc_grants / saml_sessions 가 묶인다.
 */
export const sessions = sqliteTable(
    "sessions",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        /** IdP-level session id, SAML SessionIndex / OIDC sid 로도 사용 */
        idpSessionId: text("idp_session_id").notNull(),
        amr: text("amr"),
        acr: text("acr"),
        ip: text("ip"),
        userAgent: text("user_agent"),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
        revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    },
    (t) => [uniqueIndex("sessions_idp_session_id_uidx").on(t.idpSessionId), index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

// ---------- OIDC ----------

export const oidcClients = sqliteTable(
    "oidc_clients",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        clientId: text("client_id").notNull(),
        clientSecretHash: text("client_secret_hash"),
        name: text("name").notNull(),
        redirectUris: text("redirect_uris").notNull(),
        postLogoutRedirectUris: text("post_logout_redirect_uris"),
        scopes: text("scopes").notNull().default("openid"),
        grantTypes: text("grant_types").notNull().default("authorization_code,refresh_token"),
        responseTypes: text("response_types").notNull().default("code"),
        tokenEndpointAuthMethod: text("token_endpoint_auth_method", {
            enum: ["client_secret_basic", "client_secret_post", "none", "private_key_jwt"],
        })
            .notNull()
            .default("client_secret_basic"),
        requirePkce: integer("require_pkce", { mode: "boolean" }).notNull().default(true),
        idTokenSignedResponseAlg: text("id_token_signed_response_alg").notNull().default("RS256"),
        jwksUri: text("jwks_uri"),
        jwks: text("jwks"),
        enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [uniqueIndex("oidc_clients_tenant_client_id_uidx").on(t.tenantId, t.clientId), index("oidc_clients_tenant_idx").on(t.tenantId)],
);

export const oidcGrants = sqliteTable(
    "oidc_grants",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        clientId: text("client_id").notNull(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
        code: text("code").notNull(),
        codeChallenge: text("code_challenge"),
        codeChallengeMethod: text("code_challenge_method", { enum: ["S256", "plain"] }),
        redirectUri: text("redirect_uri").notNull(),
        scope: text("scope").notNull(),
        nonce: text("nonce"),
        state: text("state"),
        acr: text("acr"),
        expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
        usedAt: integer("used_at", { mode: "timestamp_ms" }),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [uniqueIndex("oidc_grants_code_uidx").on(t.code), index("oidc_grants_tenant_client_idx").on(t.tenantId, t.clientId), index("oidc_grants_expires_idx").on(t.expiresAt)],
);

export const oidcRefreshTokens = sqliteTable(
    "oidc_refresh_tokens",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        clientId: text("client_id").notNull(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
        tokenHash: text("token_hash").notNull(),
        scope: text("scope").notNull(),
        expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
        revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
        replacedById: text("replaced_by_id"),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [uniqueIndex("oidc_refresh_tokens_hash_uidx").on(t.tokenHash), index("oidc_refresh_tokens_user_idx").on(t.userId)],
);

// ---------- SAML ----------

export const samlSps = sqliteTable(
    "saml_sps",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        entityId: text("entity_id").notNull(),
        name: text("name").notNull(),
        acsUrl: text("acs_url").notNull(),
        acsBinding: text("acs_binding").notNull().default("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"),
        sloUrl: text("slo_url"),
        sloBinding: text("slo_binding"),
        cert: text("cert"),
        nameIdFormat: text("name_id_format").notNull().default("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"),
        signAssertion: integer("sign_assertion", { mode: "boolean" }).notNull().default(true),
        signResponse: integer("sign_response", { mode: "boolean" }).notNull().default(false),
        encryptAssertion: integer("encrypt_assertion", { mode: "boolean" }).notNull().default(false),
        wantAuthnRequestsSigned: integer("want_authn_requests_signed", { mode: "boolean" }).notNull().default(false),
        attributeMappingJson: text("attribute_mapping_json"),
        // JSON 배열 문자열 (예: ["email","department"]). NULL 이면 기본 최소 집합만 허용.
        allowedAttributes: text("allowed_attributes"),
        enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [uniqueIndex("saml_sps_tenant_entity_id_uidx").on(t.tenantId, t.entityId), index("saml_sps_tenant_idx").on(t.tenantId)],
);

export const samlSessions = sqliteTable(
    "saml_sessions",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        spId: text("sp_id")
            .notNull()
            .references(() => samlSps.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
        sessionIndex: text("session_index").notNull(),
        nameId: text("name_id").notNull(),
        nameIdFormat: text("name_id_format"),
        notOnOrAfter: integer("not_on_or_after", { mode: "timestamp_ms" }).notNull(),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    },
    (t) => [uniqueIndex("saml_sessions_session_index_uidx").on(t.sessionIndex), index("saml_sessions_tenant_sp_idx").on(t.tenantId, t.spId)],
);

// ---------- Keys & Audit ----------

/**
 * 서명 키. 테넌트별 독립. kid 로 선택하며, rotation 시 active 는 한 번에 하나,
 * 구 키는 `rotatedAt` 이 설정된 채로 검증용으로 남는다.
 */
export const signingKeys = sqliteTable(
    "signing_keys",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        kid: text("kid").notNull(),
        use: text("use", { enum: ["sig", "enc"] })
            .notNull()
            .default("sig"),
        alg: text("alg").notNull(),
        publicJwk: text("public_jwk").notNull(),
        privateJwkEncrypted: text("private_jwk_encrypted").notNull(),
        certPem: text("cert_pem"),
        active: integer("active", { mode: "boolean" }).notNull().default(true),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
        notAfter: integer("not_after", { mode: "timestamp_ms" }),
    },
    (t) => [uniqueIndex("signing_keys_tenant_kid_uidx").on(t.tenantId, t.kid), index("signing_keys_tenant_active_idx").on(t.tenantId, t.active)],
);

export const auditEvents = sqliteTable(
    "audit_events",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
        actorId: text("actor_id"),
        spOrClientId: text("sp_or_client_id"),
        kind: text("kind").notNull(),
        outcome: text("outcome", { enum: ["success", "failure"] }).notNull(),
        ip: text("ip"),
        userAgent: text("user_agent"),
        detailJson: text("detail_json"),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [index("audit_events_tenant_kind_idx").on(t.tenantId, t.kind), index("audit_events_tenant_created_idx").on(t.tenantId, t.createdAt), index("audit_events_user_idx").on(t.userId)],
);

// ---------- Organization ----------

/**
 * 직급 마스터. 테넌트별 독립 관리.
 * 예: 사원(10) → 대리(20) → 과장(30) → 차장(40) → 부장(50) → 이사(60)
 */
export const positions = sqliteTable(
    "positions",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        name: text("name").notNull(),
        code: text("code"),
        level: integer("level").notNull().default(0), // 높을수록 고위직
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [index("positions_tenant_idx").on(t.tenantId), uniqueIndex("positions_tenant_code_uidx").on(t.tenantId, t.code)],
);

/**
 * 부서. parentId 로 계층 구조(트리) 표현.
 * 최상위 부서는 parentId=NULL.
 */
export const departments = sqliteTable(
    "departments",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        parentId: text("parent_id").references((): AnySQLiteColumn => departments.id, {
            onDelete: "set null",
        }),
        name: text("name").notNull(),
        code: text("code"),
        description: text("description"),
        managerId: text("manager_id").references(() => users.id, { onDelete: "set null" }),
        displayOrder: integer("display_order").notNull().default(0),
        status: text("status", { enum: ["active", "inactive"] })
            .notNull()
            .default("active"),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [index("departments_tenant_idx").on(t.tenantId), index("departments_parent_idx").on(t.parentId), uniqueIndex("departments_tenant_code_uidx").on(t.tenantId, t.code)],
);

/**
 * 팀. 부서 하위에 속하거나(departmentId 있음), 독립적으로 존재 가능.
 */
export const teams = sqliteTable(
    "teams",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        departmentId: text("department_id").references(() => departments.id, {
            onDelete: "set null",
        }),
        name: text("name").notNull(),
        code: text("code"),
        description: text("description"),
        leaderId: text("leader_id").references(() => users.id, { onDelete: "set null" }),
        status: text("status", { enum: ["active", "inactive"] })
            .notNull()
            .default("active"),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [index("teams_tenant_idx").on(t.tenantId), index("teams_department_idx").on(t.departmentId), uniqueIndex("teams_tenant_code_uidx").on(t.tenantId, t.code)],
);

/**
 * 유저↔부서 소속 (N:M). 겸직·복수 소속 지원.
 * isPrimary=true 인 행이 주소속 부서.
 * endedAt=NULL 이면 현재 소속.
 */
export const userDepartments = sqliteTable(
    "user_departments",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        departmentId: text("department_id")
            .notNull()
            .references(() => departments.id, { onDelete: "cascade" }),
        positionId: text("position_id").references(() => positions.id, { onDelete: "set null" }),
        jobTitle: text("job_title"), // 직책 (팀장, 파트장, 실장 …)
        isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
        startedAt: integer("started_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        endedAt: integer("ended_at", { mode: "timestamp_ms" }),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [index("user_departments_user_idx").on(t.userId), index("user_departments_dept_idx").on(t.departmentId), index("user_departments_tenant_idx").on(t.tenantId)],
);

/**
 * 파트. 팀 하위 단위. teamId(nullable)로 팀 소속 또는 독립 구성.
 */
export const parts = sqliteTable(
    "parts",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
        name: text("name").notNull(),
        code: text("code"),
        description: text("description"),
        leaderId: text("leader_id").references(() => users.id, { onDelete: "set null" }),
        status: text("status", { enum: ["active", "inactive"] })
            .notNull()
            .default("active"),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [index("parts_tenant_idx").on(t.tenantId), index("parts_team_idx").on(t.teamId), uniqueIndex("parts_tenant_code_uidx").on(t.tenantId, t.code)],
);

/**
 * 유저↔파트 소속 (N:M).
 */
export const userParts = sqliteTable(
    "user_parts",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        partId: text("part_id")
            .notNull()
            .references(() => parts.id, { onDelete: "cascade" }),
        jobTitle: text("job_title"),
        isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
        startedAt: integer("started_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        endedAt: integer("ended_at", { mode: "timestamp_ms" }),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [index("user_parts_user_idx").on(t.userId), index("user_parts_part_idx").on(t.partId), index("user_parts_tenant_idx").on(t.tenantId)],
);

/**
 * 유저↔팀 소속 (N:M). 복수 팀 동시 소속 지원.
 * isPrimary=true 인 행이 주소속 팀.
 * endedAt=NULL 이면 현재 소속.
 */
export const userTeams = sqliteTable(
    "user_teams",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        teamId: text("team_id")
            .notNull()
            .references(() => teams.id, { onDelete: "cascade" }),
        jobTitle: text("job_title"), // 팀 내 역할 (팀장, 멤버 …)
        isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
        startedAt: integer("started_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
        endedAt: integer("ended_at", { mode: "timestamp_ms" }),
        createdAt: integer("created_at", { mode: "timestamp_ms" })
            .notNull()
            .default(sql`(unixepoch() * 1000)`),
    },
    (t) => [index("user_teams_user_idx").on(t.userId), index("user_teams_team_idx").on(t.teamId), index("user_teams_tenant_idx").on(t.tenantId)],
);

// ---------- WebAuthn Challenges ----------

/**
 * WebAuthn 1회용 챌린지. options 응답 시 INSERT, verify 시 atomic UPDATE 로 usedAt 마킹.
 * 만료/재사용 챌린지는 거부된다.
 */
export const webauthnChallenges = sqliteTable(
    "webauthn_challenges",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        challenge: text("challenge").notNull(),
        expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
        usedAt: integer("used_at", { mode: "timestamp_ms" }),
    },
    (t) => [uniqueIndex("webauthn_challenges_challenge_uidx").on(t.challenge), index("webauthn_challenges_expires_idx").on(t.expiresAt)],
);

// ---------- Types ----------

export type Tenant = typeof tenants.$inferSelect;
// ---------- Rate Limits ----------

export const rateLimits = sqliteTable("rate_limits", {
    key: text("key").primaryKey(),
    count: integer("count").notNull().default(1),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const clientSkins = sqliteTable(
    "client_skins",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        tenantId: text("tenant_id")
            .notNull()
            .references(() => tenants.id, { onDelete: "cascade" }),
        clientType: text("client_type", { enum: ["oidc", "saml"] }).notNull(),
        clientRefId: text("client_ref_id").notNull(),
        skinType: text("skin_type", { enum: ["login", "signup", "find_id", "find_password"] })
            .notNull()
            .default("login"),
        fetchUrl: text("fetch_url").notNull(),
        fetchSecret: text("fetch_secret"),
        cacheTtlSeconds: integer("cache_ttl_seconds").notNull().default(3600),
        enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .$defaultFn(() => new Date()),
    },
    (t) => [uniqueIndex("client_skins_unique").on(t.tenantId, t.clientType, t.clientRefId, t.skinType)],
);

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
export type Position = typeof positions.$inferSelect;
export type Department = typeof departments.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type UserDepartment = typeof userDepartments.$inferSelect;
export type UserTeam = typeof userTeams.$inferSelect;
export type Part = typeof parts.$inferSelect;
export type UserPart = typeof userParts.$inferSelect;
export type WebauthnChallenge = typeof webauthnChallenges.$inferSelect;
export type ClientSkin = typeof clientSkins.$inferSelect;

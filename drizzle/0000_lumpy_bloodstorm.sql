CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text,
	`actor_id` text,
	`sp_or_client_id` text,
	`kind` text NOT NULL,
	`outcome` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`detail_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_events_tenant_kind_idx` ON `audit_events` (`tenant_id`,`kind`);--> statement-breakpoint
CREATE INDEX `audit_events_tenant_created_idx` ON `audit_events` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_user_idx` ON `audit_events` (`user_id`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`label` text,
	`secret` text,
	`public_key` text,
	`credential_id` text,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`last_used_at` integer,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `credentials_user_idx` ON `credentials` (`user_id`);--> statement-breakpoint
CREATE INDEX `credentials_user_type_idx` ON `credentials` (`user_id`,`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_webauthn_credential_id_uidx` ON `credentials` (`credential_id`);--> statement-breakpoint
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`raw_profile_json` text,
	`linked_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_login_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identities_tenant_provider_subject_uidx` ON `identities` (`tenant_id`,`provider`,`subject`);--> statement-breakpoint
CREATE INDEX `identities_user_idx` ON `identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `identity_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`client_id` text,
	`client_secret_enc` text,
	`discovery_url` text,
	`metadata_xml` text,
	`scopes` text,
	`config_json` text,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idp_tenant_idx` ON `identity_providers` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idp_tenant_name_uidx` ON `identity_providers` (`tenant_id`,`name`);--> statement-breakpoint
CREATE TABLE `oidc_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_hash` text,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text,
	`scopes` text DEFAULT 'openid' NOT NULL,
	`grant_types` text DEFAULT 'authorization_code,refresh_token' NOT NULL,
	`response_types` text DEFAULT 'code' NOT NULL,
	`token_endpoint_auth_method` text DEFAULT 'client_secret_basic' NOT NULL,
	`require_pkce` integer DEFAULT true NOT NULL,
	`id_token_signed_response_alg` text DEFAULT 'RS256' NOT NULL,
	`jwks_uri` text,
	`jwks` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_clients_tenant_client_id_uidx` ON `oidc_clients` (`tenant_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `oidc_clients_tenant_idx` ON `oidc_clients` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `oidc_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text,
	`code` text NOT NULL,
	`code_challenge` text,
	`code_challenge_method` text,
	`redirect_uri` text NOT NULL,
	`scope` text NOT NULL,
	`nonce` text,
	`state` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_grants_code_uidx` ON `oidc_grants` (`code`);--> statement-breakpoint
CREATE INDEX `oidc_grants_tenant_client_idx` ON `oidc_grants` (`tenant_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `oidc_grants_expires_idx` ON `oidc_grants` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oidc_refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text,
	`token_hash` text NOT NULL,
	`scope` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`replaced_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_refresh_tokens_hash_uidx` ON `oidc_refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `oidc_refresh_tokens_user_idx` ON `oidc_refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `saml_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`sp_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text,
	`session_index` text NOT NULL,
	`name_id` text NOT NULL,
	`name_id_format` text,
	`not_on_or_after` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sp_id`) REFERENCES `saml_sps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_sessions_session_index_uidx` ON `saml_sessions` (`session_index`);--> statement-breakpoint
CREATE INDEX `saml_sessions_tenant_sp_idx` ON `saml_sessions` (`tenant_id`,`sp_id`);--> statement-breakpoint
CREATE TABLE `saml_sps` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`name` text NOT NULL,
	`acs_url` text NOT NULL,
	`acs_binding` text DEFAULT 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST' NOT NULL,
	`slo_url` text,
	`slo_binding` text,
	`cert` text,
	`name_id_format` text DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' NOT NULL,
	`sign_assertion` integer DEFAULT true NOT NULL,
	`sign_response` integer DEFAULT false NOT NULL,
	`encrypt_assertion` integer DEFAULT false NOT NULL,
	`want_authn_requests_signed` integer DEFAULT false NOT NULL,
	`attribute_mapping_json` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_sps_tenant_entity_id_uidx` ON `saml_sps` (`tenant_id`,`entity_id`);--> statement-breakpoint
CREATE INDEX `saml_sps_tenant_idx` ON `saml_sps` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`idp_session_id` text NOT NULL,
	`amr` text,
	`acr` text,
	`ip` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_idp_session_id_uidx` ON `sessions` (`idp_session_id`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `signing_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kid` text NOT NULL,
	`use` text DEFAULT 'sig' NOT NULL,
	`alg` text NOT NULL,
	`public_jwk` text NOT NULL,
	`private_jwk_encrypted` text NOT NULL,
	`cert_pem` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`rotated_at` integer,
	`not_after` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signing_keys_tenant_kid_uidx` ON `signing_keys` (`tenant_id`,`kid`);--> statement-breakpoint
CREATE INDEX `signing_keys_tenant_active_idx` ON `signing_keys` (`tenant_id`,`active`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_uidx` ON `tenants` (`slug`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email` text NOT NULL,
	`email_verified_at` integer,
	`display_name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_tenant_email_uidx` ON `users` (`tenant_id`,`email`);--> statement-breakpoint
CREATE INDEX `users_tenant_idx` ON `users` (`tenant_id`);
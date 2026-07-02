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
CREATE TABLE `client_skins` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_type` text NOT NULL,
	`client_ref_id` text NOT NULL,
	`skin_type` text DEFAULT 'login' NOT NULL,
	`fetch_url` text NOT NULL,
	`fetch_secret` text,
	`cache_ttl_seconds` integer DEFAULT 3600 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_skins_unique` ON `client_skins` (`tenant_id`,`client_type`,`client_ref_id`,`skin_type`);--> statement-breakpoint
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
CREATE TABLE `departments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`code` text,
	`description` text,
	`manager_id` text,
	`display_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`manager_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `departments_tenant_idx` ON `departments` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `departments_parent_idx` ON `departments` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `departments_tenant_code_uidx` ON `departments` (`tenant_id`,`code`);--> statement-breakpoint
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
	`frontchannel_logout_uri` text,
	`frontchannel_logout_session_required` integer DEFAULT false NOT NULL,
	`backchannel_logout_uri` text,
	`backchannel_logout_session_required` integer DEFAULT false NOT NULL,
	`scopes` text DEFAULT 'openid' NOT NULL,
	`grant_types` text DEFAULT 'authorization_code,refresh_token' NOT NULL,
	`response_types` text DEFAULT 'code' NOT NULL,
	`token_endpoint_auth_method` text DEFAULT 'client_secret_basic' NOT NULL,
	`require_pkce` integer DEFAULT true NOT NULL,
	`allow_wildcard_redirect_uri` integer DEFAULT false NOT NULL,
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
	`code` text,
	`code_hash` text,
	`code_challenge` text,
	`code_challenge_method` text,
	`redirect_uri` text NOT NULL,
	`scope` text NOT NULL,
	`nonce` text,
	`state` text,
	`acr` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_grants_code_uidx` ON `oidc_grants` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_grants_code_hash_uidx` ON `oidc_grants` (`code_hash`);--> statement-breakpoint
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
CREATE TABLE `parts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`team_id` text,
	`name` text NOT NULL,
	`code` text,
	`description` text,
	`leader_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`leader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `parts_tenant_idx` ON `parts` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `parts_team_idx` ON `parts` (`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `parts_tenant_code_uidx` ON `parts` (`tenant_id`,`code`);--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `password_reset_tokens_user_idx` ON `password_reset_tokens` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `password_reset_tokens_hash_uidx` ON `password_reset_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `positions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`code` text,
	`level` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `positions_tenant_idx` ON `positions` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `positions_tenant_code_uidx` ON `positions` (`tenant_id`,`code`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saml_authn_request_ids` (
	`tenant_id` text NOT NULL,
	`request_id` text NOT NULL,
	`sp_entity_id` text NOT NULL,
	`seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_authn_request_ids_tenant_req_uidx` ON `saml_authn_request_ids` (`tenant_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `saml_authn_request_ids_expires_idx` ON `saml_authn_request_ids` (`expires_at`);--> statement-breakpoint
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
CREATE TABLE `saml_slo_states` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`idp_session_record_id` text NOT NULL,
	`user_id` text NOT NULL,
	`initiating_sp_entity_id` text,
	`in_response_to` text,
	`initiator_slo_url` text,
	`completion_uri` text NOT NULL,
	`pending_sp_data_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
	`sign_response` integer DEFAULT true NOT NULL,
	`encrypt_assertion` integer DEFAULT false NOT NULL,
	`want_authn_requests_signed` integer DEFAULT false NOT NULL,
	`attribute_mapping_json` text,
	`allowed_attributes` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_sps_tenant_entity_id_uidx` ON `saml_sps` (`tenant_id`,`entity_id`);--> statement-breakpoint
CREATE INDEX `saml_sps_tenant_idx` ON `saml_sps` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `service_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`service_type` text NOT NULL,
	`service_ref_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`is_default` integer DEFAULT false NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_roles_service_key_uidx` ON `service_roles` (`service_type`,`service_ref_id`,`key`);--> statement-breakpoint
CREATE INDEX `service_roles_tenant_service_idx` ON `service_roles` (`tenant_id`,`service_type`,`service_ref_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `signing_keys_tenant_one_active_uidx` ON `signing_keys` (`tenant_id`) WHERE active = 1;--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`department_id` text,
	`name` text NOT NULL,
	`code` text,
	`description` text,
	`leader_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`leader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `teams_tenant_idx` ON `teams` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `teams_department_idx` ON `teams` (`department_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `teams_tenant_code_uidx` ON `teams` (`tenant_id`,`code`);--> statement-breakpoint
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
CREATE TABLE `user_departments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`department_id` text NOT NULL,
	`position_id` text,
	`job_title` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ended_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `user_departments_user_idx` ON `user_departments` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_departments_dept_idx` ON `user_departments` (`department_id`);--> statement-breakpoint
CREATE INDEX `user_departments_tenant_idx` ON `user_departments` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `user_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`part_id` text NOT NULL,
	`job_title` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ended_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_parts_user_idx` ON `user_parts` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_parts_part_idx` ON `user_parts` (`part_id`);--> statement-breakpoint
CREATE INDEX `user_parts_tenant_idx` ON `user_parts` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `user_service_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`service_type` text NOT NULL,
	`service_ref_id` text NOT NULL,
	`service_role_id` text,
	`attributes_json` text,
	`granted_by` text,
	`granted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_role_id`) REFERENCES `service_roles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_service_assignments_user_service_uidx` ON `user_service_assignments` (`tenant_id`,`user_id`,`service_type`,`service_ref_id`);--> statement-breakpoint
CREATE INDEX `user_service_assignments_tenant_user_idx` ON `user_service_assignments` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `user_service_assignments_tenant_service_idx` ON `user_service_assignments` (`tenant_id`,`service_type`,`service_ref_id`);--> statement-breakpoint
CREATE TABLE `user_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`team_id` text NOT NULL,
	`job_title` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ended_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_teams_user_idx` ON `user_teams` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_teams_team_idx` ON `user_teams` (`team_id`);--> statement-breakpoint
CREATE INDEX `user_teams_tenant_idx` ON `user_teams` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`username` text,
	`email` text NOT NULL,
	`email_verified_at` integer,
	`display_name` text,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`given_name` text,
	`family_name` text,
	`phone_number` text,
	`phone_verified_at` integer,
	`avatar_url` text,
	`locale` text DEFAULT 'ko-KR',
	`zoneinfo` text DEFAULT 'Asia/Seoul',
	`bio` text,
	`birthdate` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_tenant_email_uidx` ON `users` (`tenant_id`,`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_tenant_username_uidx` ON `users` (`tenant_id`,`username`);--> statement-breakpoint
CREATE INDEX `users_tenant_idx` ON `users` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`user_id` text,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_challenges_tenant_challenge_uidx` ON `webauthn_challenges` (`tenant_id`,`challenge`);--> statement-breakpoint
CREATE INDEX `webauthn_challenges_tenant_expires_idx` ON `webauthn_challenges` (`tenant_id`,`expires_at`);
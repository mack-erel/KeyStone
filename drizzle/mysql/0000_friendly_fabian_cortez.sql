CREATE TABLE `audit_events` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`user_id` varchar(64),
	`actor_id` text,
	`sp_or_client_id` text,
	`kind` varchar(255) NOT NULL,
	`outcome` varchar(64) NOT NULL,
	`ip` text,
	`user_agent` text,
	`detail_json` text,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `audit_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `client_skins` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`client_type` varchar(64) NOT NULL,
	`client_ref_id` varchar(64) NOT NULL,
	`skin_type` varchar(64) NOT NULL DEFAULT 'login',
	`fetch_url` text NOT NULL,
	`fetch_secret` text,
	`cache_ttl_seconds` int NOT NULL DEFAULT 3600,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `client_skins_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_skins_unique` UNIQUE(`tenant_id`,`client_type`,`client_ref_id`,`skin_type`)
);
--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`type` varchar(64) NOT NULL,
	`label` text,
	`secret` text,
	`public_key` text,
	`credential_id` varchar(255),
	`counter` int NOT NULL DEFAULT 0,
	`transports` text,
	`last_used_at` datetime(3),
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `credentials_id` PRIMARY KEY(`id`),
	CONSTRAINT `credentials_webauthn_credential_id_uidx` UNIQUE(`credential_id`)
);
--> statement-breakpoint
CREATE TABLE `departments` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`parent_id` varchar(64),
	`name` varchar(255) NOT NULL,
	`code` varchar(255),
	`description` text,
	`manager_id` varchar(64),
	`display_order` int NOT NULL DEFAULT 0,
	`status` varchar(64) NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `departments_id` PRIMARY KEY(`id`),
	CONSTRAINT `departments_tenant_code_uidx` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `identities` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`provider` varchar(255) NOT NULL,
	`subject` varchar(255) NOT NULL,
	`email` text,
	`raw_profile_json` text,
	`linked_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`last_login_at` datetime(3),
	CONSTRAINT `identities_id` PRIMARY KEY(`id`),
	CONSTRAINT `identities_tenant_provider_subject_uidx` UNIQUE(`tenant_id`,`provider`,`subject`)
);
--> statement-breakpoint
CREATE TABLE `identity_providers` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`kind` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`client_id` text,
	`client_secret_enc` text,
	`discovery_url` text,
	`metadata_xml` text,
	`scopes` text,
	`config_json` text,
	`enabled` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `identity_providers_id` PRIMARY KEY(`id`),
	CONSTRAINT `idp_tenant_name_uidx` UNIQUE(`tenant_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `oidc_clients` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`client_secret_hash` varchar(255),
	`name` varchar(255) NOT NULL,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text,
	`frontchannel_logout_uri` text,
	`frontchannel_logout_session_required` boolean NOT NULL DEFAULT false,
	`backchannel_logout_uri` text,
	`backchannel_logout_session_required` boolean NOT NULL DEFAULT false,
	`scopes` text NOT NULL DEFAULT ('openid'),
	`grant_types` text NOT NULL DEFAULT ('authorization_code,refresh_token'),
	`response_types` text NOT NULL DEFAULT ('code'),
	`token_endpoint_auth_method` varchar(64) NOT NULL DEFAULT 'client_secret_basic',
	`require_pkce` boolean NOT NULL DEFAULT true,
	`allow_wildcard_redirect_uri` boolean NOT NULL DEFAULT false,
	`id_token_signed_response_alg` text NOT NULL DEFAULT ('RS256'),
	`jwks_uri` text,
	`jwks` text,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `oidc_clients_id` PRIMARY KEY(`id`),
	CONSTRAINT `oidc_clients_tenant_client_id_uidx` UNIQUE(`tenant_id`,`client_id`)
);
--> statement-breakpoint
CREATE TABLE `oidc_grants` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`session_id` varchar(64),
	`code` varchar(255),
	`code_hash` varchar(255),
	`code_challenge` text,
	`code_challenge_method` varchar(64),
	`redirect_uri` text NOT NULL,
	`scope` text NOT NULL,
	`nonce` text,
	`state` text,
	`acr` text,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `oidc_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `oidc_grants_code_uidx` UNIQUE(`code`),
	CONSTRAINT `oidc_grants_code_hash_uidx` UNIQUE(`code_hash`)
);
--> statement-breakpoint
CREATE TABLE `oidc_refresh_tokens` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`session_id` varchar(64),
	`token_hash` varchar(255) NOT NULL,
	`scope` text NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`replaced_by_id` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `oidc_refresh_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `oidc_refresh_tokens_hash_uidx` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `parts` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`team_id` varchar(64),
	`name` varchar(255) NOT NULL,
	`code` varchar(255),
	`description` text,
	`leader_id` varchar(64),
	`status` varchar(64) NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `parts_id` PRIMARY KEY(`id`),
	CONSTRAINT `parts_tenant_code_uidx` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
	`id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`token_hash` varchar(255) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `password_reset_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `password_reset_tokens_hash_uidx` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`code` varchar(255),
	`level` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `positions_id` PRIMARY KEY(`id`),
	CONSTRAINT `positions_tenant_code_uidx` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` varchar(255) NOT NULL,
	`count` int NOT NULL DEFAULT 1,
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `rate_limits_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `saml_authn_request_ids` (
	`tenant_id` varchar(64) NOT NULL,
	`request_id` varchar(255) NOT NULL,
	`sp_entity_id` varchar(255) NOT NULL,
	`seen_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `saml_authn_request_ids_tenant_req_uidx` UNIQUE(`tenant_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `saml_sessions` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`sp_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`session_id` varchar(64),
	`session_index` varchar(255) NOT NULL,
	`name_id` text NOT NULL,
	`name_id_format` varchar(255),
	`not_on_or_after` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`ended_at` datetime(3),
	CONSTRAINT `saml_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `saml_sessions_session_index_uidx` UNIQUE(`session_index`)
);
--> statement-breakpoint
CREATE TABLE `saml_slo_states` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`idp_session_record_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`initiating_sp_entity_id` text,
	`in_response_to` text,
	`initiator_slo_url` text,
	`completion_uri` text NOT NULL,
	`pending_sp_data_json` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `saml_slo_states_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `saml_sps` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`entity_id` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`acs_url` text NOT NULL,
	`acs_binding` varchar(255) NOT NULL DEFAULT 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
	`slo_url` text,
	`slo_binding` varchar(255),
	`cert` text,
	`name_id_format` varchar(255) NOT NULL DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
	`sign_assertion` boolean NOT NULL DEFAULT true,
	`sign_response` boolean NOT NULL DEFAULT true,
	`encrypt_assertion` boolean NOT NULL DEFAULT false,
	`want_authn_requests_signed` boolean NOT NULL DEFAULT false,
	`attribute_mapping_json` text,
	`allowed_attributes` text,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `saml_sps_id` PRIMARY KEY(`id`),
	CONSTRAINT `saml_sps_tenant_entity_id_uidx` UNIQUE(`tenant_id`,`entity_id`)
);
--> statement-breakpoint
CREATE TABLE `service_roles` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`service_type` varchar(64) NOT NULL,
	`service_ref_id` varchar(64) NOT NULL,
	`key` varchar(255) NOT NULL,
	`label` varchar(255) NOT NULL,
	`description` text,
	`is_default` boolean NOT NULL DEFAULT false,
	`display_order` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `service_roles_id` PRIMARY KEY(`id`),
	CONSTRAINT `service_roles_service_key_uidx` UNIQUE(`service_type`,`service_ref_id`,`key`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`idp_session_id` varchar(255) NOT NULL,
	`amr` text,
	`acr` text,
	`ip` text,
	`user_agent` text,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`last_seen_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sessions_idp_session_id_uidx` UNIQUE(`idp_session_id`)
);
--> statement-breakpoint
CREATE TABLE `signing_keys` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`kid` varchar(255) NOT NULL,
	`use` varchar(64) NOT NULL DEFAULT 'sig',
	`alg` text NOT NULL,
	`public_jwk` text NOT NULL,
	`private_jwk_encrypted` text NOT NULL,
	`cert_pem` text,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`rotated_at` datetime(3),
	`not_after` datetime(3),
	CONSTRAINT `signing_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `signing_keys_tenant_kid_uidx` UNIQUE(`tenant_id`,`kid`)
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`department_id` varchar(64),
	`name` varchar(255) NOT NULL,
	`code` varchar(255),
	`description` text,
	`leader_id` varchar(64),
	`status` varchar(64) NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `teams_id` PRIMARY KEY(`id`),
	CONSTRAINT `teams_tenant_code_uidx` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` varchar(64) NOT NULL,
	`slug` varchar(255) NOT NULL,
	`name` text NOT NULL,
	`status` varchar(64) NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `tenants_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenants_slug_uidx` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `user_departments` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`department_id` varchar(64) NOT NULL,
	`position_id` varchar(64),
	`job_title` text,
	`is_primary` boolean NOT NULL DEFAULT false,
	`started_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`ended_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `user_departments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_parts` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`part_id` varchar(64) NOT NULL,
	`job_title` text,
	`is_primary` boolean NOT NULL DEFAULT false,
	`started_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`ended_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `user_parts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_service_assignments` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`service_type` varchar(64) NOT NULL,
	`service_ref_id` varchar(64) NOT NULL,
	`service_role_id` varchar(64),
	`attributes_json` text,
	`granted_by` text,
	`granted_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`expires_at` datetime(3),
	`revoked_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `user_service_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_service_assignments_user_service_uidx` UNIQUE(`tenant_id`,`user_id`,`service_type`,`service_ref_id`)
);
--> statement-breakpoint
CREATE TABLE `user_teams` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`team_id` varchar(64) NOT NULL,
	`job_title` text,
	`is_primary` boolean NOT NULL DEFAULT false,
	`started_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`ended_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `user_teams_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64) NOT NULL,
	`username` varchar(255),
	`email` varchar(320) NOT NULL,
	`email_verified_at` datetime(3),
	`display_name` text,
	`role` varchar(64) NOT NULL DEFAULT 'user',
	`status` varchar(64) NOT NULL DEFAULT 'active',
	`given_name` text,
	`family_name` text,
	`phone_number` text,
	`phone_verified_at` datetime(3),
	`avatar_url` text,
	`locale` text DEFAULT ('ko-KR'),
	`zoneinfo` text DEFAULT ('Asia/Seoul'),
	`bio` text,
	`birthdate` text,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_tenant_email_uidx` UNIQUE(`tenant_id`,`email`),
	CONSTRAINT `users_tenant_username_uidx` UNIQUE(`tenant_id`,`username`)
);
--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`id` varchar(64) NOT NULL,
	`tenant_id` varchar(64),
	`user_id` varchar(64),
	`challenge` varchar(255) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	CONSTRAINT `webauthn_challenges_id` PRIMARY KEY(`id`),
	CONSTRAINT `webauthn_challenges_tenant_challenge_uidx` UNIQUE(`tenant_id`,`challenge`)
);
--> statement-breakpoint
ALTER TABLE `audit_events` ADD CONSTRAINT `audit_events_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_events` ADD CONSTRAINT `audit_events_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_skins` ADD CONSTRAINT `client_skins_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credentials` ADD CONSTRAINT `credentials_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `departments` ADD CONSTRAINT `departments_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `departments` ADD CONSTRAINT `departments_parent_id_departments_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `departments`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `departments` ADD CONSTRAINT `departments_manager_id_users_id_fk` FOREIGN KEY (`manager_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `identities` ADD CONSTRAINT `identities_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `identities` ADD CONSTRAINT `identities_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `identity_providers` ADD CONSTRAINT `identity_providers_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oidc_clients` ADD CONSTRAINT `oidc_clients_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oidc_grants` ADD CONSTRAINT `oidc_grants_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oidc_grants` ADD CONSTRAINT `oidc_grants_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oidc_grants` ADD CONSTRAINT `oidc_grants_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oidc_refresh_tokens` ADD CONSTRAINT `oidc_refresh_tokens_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oidc_refresh_tokens` ADD CONSTRAINT `oidc_refresh_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oidc_refresh_tokens` ADD CONSTRAINT `oidc_refresh_tokens_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `parts` ADD CONSTRAINT `parts_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `parts` ADD CONSTRAINT `parts_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `parts` ADD CONSTRAINT `parts_leader_id_users_id_fk` FOREIGN KEY (`leader_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `password_reset_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `positions` ADD CONSTRAINT `positions_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `saml_authn_request_ids` ADD CONSTRAINT `saml_authn_request_ids_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `saml_sessions` ADD CONSTRAINT `saml_sessions_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `saml_sessions` ADD CONSTRAINT `saml_sessions_sp_id_saml_sps_id_fk` FOREIGN KEY (`sp_id`) REFERENCES `saml_sps`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `saml_sessions` ADD CONSTRAINT `saml_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `saml_sessions` ADD CONSTRAINT `saml_sessions_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `saml_slo_states` ADD CONSTRAINT `saml_slo_states_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `saml_slo_states` ADD CONSTRAINT `saml_slo_states_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `saml_sps` ADD CONSTRAINT `saml_sps_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `service_roles` ADD CONSTRAINT `service_roles_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `signing_keys` ADD CONSTRAINT `signing_keys_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teams` ADD CONSTRAINT `teams_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teams` ADD CONSTRAINT `teams_department_id_departments_id_fk` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teams` ADD CONSTRAINT `teams_leader_id_users_id_fk` FOREIGN KEY (`leader_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_departments` ADD CONSTRAINT `user_departments_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_departments` ADD CONSTRAINT `user_departments_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_departments` ADD CONSTRAINT `user_departments_department_id_departments_id_fk` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_departments` ADD CONSTRAINT `user_departments_position_id_positions_id_fk` FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_parts` ADD CONSTRAINT `user_parts_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_parts` ADD CONSTRAINT `user_parts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_parts` ADD CONSTRAINT `user_parts_part_id_parts_id_fk` FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_service_assignments` ADD CONSTRAINT `user_service_assignments_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_service_assignments` ADD CONSTRAINT `user_service_assignments_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_service_assignments` ADD CONSTRAINT `user_service_assignments_service_role_id_service_roles_id_fk` FOREIGN KEY (`service_role_id`) REFERENCES `service_roles`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_teams` ADD CONSTRAINT `user_teams_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_teams` ADD CONSTRAINT `user_teams_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_teams` ADD CONSTRAINT `user_teams_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `webauthn_challenges` ADD CONSTRAINT `webauthn_challenges_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `webauthn_challenges` ADD CONSTRAINT `webauthn_challenges_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_events_tenant_kind_idx` ON `audit_events` (`tenant_id`,`kind`);--> statement-breakpoint
CREATE INDEX `audit_events_tenant_created_idx` ON `audit_events` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_user_idx` ON `audit_events` (`user_id`);--> statement-breakpoint
CREATE INDEX `credentials_user_idx` ON `credentials` (`user_id`);--> statement-breakpoint
CREATE INDEX `credentials_user_type_idx` ON `credentials` (`user_id`,`type`);--> statement-breakpoint
CREATE INDEX `departments_tenant_idx` ON `departments` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `departments_parent_idx` ON `departments` (`parent_id`);--> statement-breakpoint
CREATE INDEX `identities_user_idx` ON `identities` (`user_id`);--> statement-breakpoint
CREATE INDEX `idp_tenant_idx` ON `identity_providers` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `oidc_clients_tenant_idx` ON `oidc_clients` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `oidc_grants_tenant_client_idx` ON `oidc_grants` (`tenant_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `oidc_grants_expires_idx` ON `oidc_grants` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oidc_refresh_tokens_user_idx` ON `oidc_refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `parts_tenant_idx` ON `parts` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `parts_team_idx` ON `parts` (`team_id`);--> statement-breakpoint
CREATE INDEX `password_reset_tokens_user_idx` ON `password_reset_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `positions_tenant_idx` ON `positions` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `saml_authn_request_ids_expires_idx` ON `saml_authn_request_ids` (`expires_at`);--> statement-breakpoint
CREATE INDEX `saml_sessions_tenant_sp_idx` ON `saml_sessions` (`tenant_id`,`sp_id`);--> statement-breakpoint
CREATE INDEX `saml_sps_tenant_idx` ON `saml_sps` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `service_roles_tenant_service_idx` ON `service_roles` (`tenant_id`,`service_type`,`service_ref_id`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `signing_keys_tenant_active_idx` ON `signing_keys` (`tenant_id`,`active`);--> statement-breakpoint
CREATE INDEX `teams_tenant_idx` ON `teams` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `teams_department_idx` ON `teams` (`department_id`);--> statement-breakpoint
CREATE INDEX `user_departments_user_idx` ON `user_departments` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_departments_dept_idx` ON `user_departments` (`department_id`);--> statement-breakpoint
CREATE INDEX `user_departments_tenant_idx` ON `user_departments` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `user_parts_user_idx` ON `user_parts` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_parts_part_idx` ON `user_parts` (`part_id`);--> statement-breakpoint
CREATE INDEX `user_parts_tenant_idx` ON `user_parts` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `user_service_assignments_tenant_user_idx` ON `user_service_assignments` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `user_service_assignments_tenant_service_idx` ON `user_service_assignments` (`tenant_id`,`service_type`,`service_ref_id`);--> statement-breakpoint
CREATE INDEX `user_teams_user_idx` ON `user_teams` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_teams_team_idx` ON `user_teams` (`team_id`);--> statement-breakpoint
CREATE INDEX `user_teams_tenant_idx` ON `user_teams` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `users_tenant_idx` ON `users` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `webauthn_challenges_tenant_expires_idx` ON `webauthn_challenges` (`tenant_id`,`expires_at`);
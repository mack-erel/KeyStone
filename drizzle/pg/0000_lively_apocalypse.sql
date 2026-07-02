CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text,
	"actor_id" text,
	"sp_or_client_id" text,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"detail_json" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_skins" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_type" text NOT NULL,
	"client_ref_id" text NOT NULL,
	"skin_type" text DEFAULT 'login' NOT NULL,
	"fetch_url" text NOT NULL,
	"fetch_secret" text,
	"cache_ttl_seconds" integer DEFAULT 3600 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"label" text,
	"secret" text,
	"public_key" text,
	"credential_id" text,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" text,
	"last_used_at" timestamp (3) with time zone,
	"used_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"manager_id" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"raw_profile_json" text,
	"linked_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "identity_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"client_id" text,
	"client_secret_enc" text,
	"discovery_url" text,
	"metadata_xml" text,
	"scopes" text,
	"config_json" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text,
	"name" text NOT NULL,
	"redirect_uris" text NOT NULL,
	"post_logout_redirect_uris" text,
	"frontchannel_logout_uri" text,
	"frontchannel_logout_session_required" boolean DEFAULT false NOT NULL,
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean DEFAULT false NOT NULL,
	"scopes" text DEFAULT 'openid' NOT NULL,
	"grant_types" text DEFAULT 'authorization_code,refresh_token' NOT NULL,
	"response_types" text DEFAULT 'code' NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'client_secret_basic' NOT NULL,
	"require_pkce" boolean DEFAULT true NOT NULL,
	"allow_wildcard_redirect_uri" boolean DEFAULT false NOT NULL,
	"id_token_signed_response_alg" text DEFAULT 'RS256' NOT NULL,
	"jwks_uri" text,
	"jwks" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text,
	"code" text,
	"code_hash" text,
	"code_challenge" text,
	"code_challenge_method" text,
	"redirect_uri" text NOT NULL,
	"scope" text NOT NULL,
	"nonce" text,
	"state" text,
	"acr" text,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text,
	"token_hash" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"replaced_by_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"team_id" text,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"leader_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"level" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saml_authn_request_ids" (
	"tenant_id" text NOT NULL,
	"request_id" text NOT NULL,
	"sp_entity_id" text NOT NULL,
	"seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saml_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"sp_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text,
	"session_index" text NOT NULL,
	"name_id" text NOT NULL,
	"name_id_format" text,
	"not_on_or_after" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "saml_slo_states" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"idp_session_record_id" text NOT NULL,
	"user_id" text NOT NULL,
	"initiating_sp_entity_id" text,
	"in_response_to" text,
	"initiator_slo_url" text,
	"completion_uri" text NOT NULL,
	"pending_sp_data_json" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saml_sps" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"name" text NOT NULL,
	"acs_url" text NOT NULL,
	"acs_binding" text DEFAULT 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST' NOT NULL,
	"slo_url" text,
	"slo_binding" text,
	"cert" text,
	"name_id_format" text DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' NOT NULL,
	"sign_assertion" boolean DEFAULT true NOT NULL,
	"sign_response" boolean DEFAULT true NOT NULL,
	"encrypt_assertion" boolean DEFAULT false NOT NULL,
	"want_authn_requests_signed" boolean DEFAULT false NOT NULL,
	"attribute_mapping_json" text,
	"allowed_attributes" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"service_type" text NOT NULL,
	"service_ref_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"idp_session_id" text NOT NULL,
	"amr" text,
	"acr" text,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "signing_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kid" text NOT NULL,
	"use" text DEFAULT 'sig' NOT NULL,
	"alg" text NOT NULL,
	"public_jwk" text NOT NULL,
	"private_jwk_encrypted" text NOT NULL,
	"cert_pem" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp (3) with time zone,
	"not_after" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"department_id" text,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"leader_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_departments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"department_id" text NOT NULL,
	"position_id" text,
	"job_title" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_parts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"part_id" text NOT NULL,
	"job_title" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_service_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"service_type" text NOT NULL,
	"service_ref_id" text NOT NULL,
	"service_role_id" text,
	"attributes_json" text,
	"granted_by" text,
	"granted_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"job_title" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"username" text,
	"email" text NOT NULL,
	"email_verified_at" timestamp (3) with time zone,
	"display_name" text,
	"role" text DEFAULT 'user' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"given_name" text,
	"family_name" text,
	"phone_number" text,
	"phone_verified_at" timestamp (3) with time zone,
	"avatar_url" text,
	"locale" text DEFAULT 'ko-KR',
	"zoneinfo" text DEFAULT 'Asia/Seoul',
	"bio" text,
	"birthdate" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"user_id" text,
	"challenge" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_skins" ADD CONSTRAINT "client_skins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_id_departments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_clients" ADD CONSTRAINT "oidc_clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_grants" ADD CONSTRAINT "oidc_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_grants" ADD CONSTRAINT "oidc_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_grants" ADD CONSTRAINT "oidc_grants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_refresh_tokens" ADD CONSTRAINT "oidc_refresh_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_refresh_tokens" ADD CONSTRAINT "oidc_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_refresh_tokens" ADD CONSTRAINT "oidc_refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_leader_id_users_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saml_authn_request_ids" ADD CONSTRAINT "saml_authn_request_ids_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saml_sessions" ADD CONSTRAINT "saml_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saml_sessions" ADD CONSTRAINT "saml_sessions_sp_id_saml_sps_id_fk" FOREIGN KEY ("sp_id") REFERENCES "public"."saml_sps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saml_sessions" ADD CONSTRAINT "saml_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saml_sessions" ADD CONSTRAINT "saml_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saml_slo_states" ADD CONSTRAINT "saml_slo_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saml_slo_states" ADD CONSTRAINT "saml_slo_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saml_sps" ADD CONSTRAINT "saml_sps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_roles" ADD CONSTRAINT "service_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_keys" ADD CONSTRAINT "signing_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_leader_id_users_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_departments" ADD CONSTRAINT "user_departments_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_parts" ADD CONSTRAINT "user_parts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_parts" ADD CONSTRAINT "user_parts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_parts" ADD CONSTRAINT "user_parts_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_service_assignments" ADD CONSTRAINT "user_service_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_service_assignments" ADD CONSTRAINT "user_service_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_service_assignments" ADD CONSTRAINT "user_service_assignments_service_role_id_service_roles_id_fk" FOREIGN KEY ("service_role_id") REFERENCES "public"."service_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_teams" ADD CONSTRAINT "user_teams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_teams" ADD CONSTRAINT "user_teams_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_teams" ADD CONSTRAINT "user_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_tenant_kind_idx" ON "audit_events" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_created_idx" ON "audit_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_user_idx" ON "audit_events" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_skins_unique" ON "client_skins" USING btree ("tenant_id","client_type","client_ref_id","skin_type");--> statement-breakpoint
CREATE INDEX "credentials_user_idx" ON "credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credentials_user_type_idx" ON "credentials" USING btree ("user_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_webauthn_credential_id_uidx" ON "credentials" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "departments_tenant_idx" ON "departments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "departments_parent_idx" ON "departments" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_tenant_code_uidx" ON "departments" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_tenant_provider_subject_uidx" ON "identities" USING btree ("tenant_id","provider","subject");--> statement-breakpoint
CREATE INDEX "identities_user_idx" ON "identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idp_tenant_idx" ON "identity_providers" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idp_tenant_name_uidx" ON "identity_providers" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_clients_tenant_client_id_uidx" ON "oidc_clients" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "oidc_clients_tenant_idx" ON "oidc_clients" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_grants_code_uidx" ON "oidc_grants" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_grants_code_hash_uidx" ON "oidc_grants" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "oidc_grants_tenant_client_idx" ON "oidc_grants" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "oidc_grants_expires_idx" ON "oidc_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_refresh_tokens_hash_uidx" ON "oidc_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "oidc_refresh_tokens_user_idx" ON "oidc_refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "parts_tenant_idx" ON "parts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "parts_team_idx" ON "parts" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parts_tenant_code_uidx" ON "parts" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_hash_uidx" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "positions_tenant_idx" ON "positions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_tenant_code_uidx" ON "positions" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "saml_authn_request_ids_tenant_req_uidx" ON "saml_authn_request_ids" USING btree ("tenant_id","request_id");--> statement-breakpoint
CREATE INDEX "saml_authn_request_ids_expires_idx" ON "saml_authn_request_ids" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "saml_sessions_session_index_uidx" ON "saml_sessions" USING btree ("session_index");--> statement-breakpoint
CREATE INDEX "saml_sessions_tenant_sp_idx" ON "saml_sessions" USING btree ("tenant_id","sp_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saml_sps_tenant_entity_id_uidx" ON "saml_sps" USING btree ("tenant_id","entity_id");--> statement-breakpoint
CREATE INDEX "saml_sps_tenant_idx" ON "saml_sps" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_roles_service_key_uidx" ON "service_roles" USING btree ("service_type","service_ref_id","key");--> statement-breakpoint
CREATE INDEX "service_roles_tenant_service_idx" ON "service_roles" USING btree ("tenant_id","service_type","service_ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_idp_session_id_uidx" ON "sessions" USING btree ("idp_session_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signing_keys_tenant_kid_uidx" ON "signing_keys" USING btree ("tenant_id","kid");--> statement-breakpoint
CREATE INDEX "signing_keys_tenant_active_idx" ON "signing_keys" USING btree ("tenant_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "signing_keys_tenant_one_active_uidx" ON "signing_keys" USING btree ("tenant_id") WHERE "signing_keys"."active";--> statement-breakpoint
CREATE INDEX "teams_tenant_idx" ON "teams" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "teams_department_idx" ON "teams" USING btree ("department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_tenant_code_uidx" ON "teams" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_uidx" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "user_departments_user_idx" ON "user_departments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_departments_dept_idx" ON "user_departments" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "user_departments_tenant_idx" ON "user_departments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "user_parts_user_idx" ON "user_parts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_parts_part_idx" ON "user_parts" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX "user_parts_tenant_idx" ON "user_parts" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_service_assignments_user_service_uidx" ON "user_service_assignments" USING btree ("tenant_id","user_id","service_type","service_ref_id");--> statement-breakpoint
CREATE INDEX "user_service_assignments_tenant_user_idx" ON "user_service_assignments" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "user_service_assignments_tenant_service_idx" ON "user_service_assignments" USING btree ("tenant_id","service_type","service_ref_id");--> statement-breakpoint
CREATE INDEX "user_teams_user_idx" ON "user_teams" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_teams_team_idx" ON "user_teams" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "user_teams_tenant_idx" ON "user_teams" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email_uidx" ON "users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_username_uidx" ON "users" USING btree ("tenant_id","username");--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webauthn_challenges_tenant_challenge_uidx" ON "webauthn_challenges" USING btree ("tenant_id","challenge");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_tenant_expires_idx" ON "webauthn_challenges" USING btree ("tenant_id","expires_at");
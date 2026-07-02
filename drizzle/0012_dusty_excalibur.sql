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
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_saml_sps` (
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
INSERT INTO `__new_saml_sps`("id", "tenant_id", "entity_id", "name", "acs_url", "acs_binding", "slo_url", "slo_binding", "cert", "name_id_format", "sign_assertion", "sign_response", "encrypt_assertion", "want_authn_requests_signed", "attribute_mapping_json", "allowed_attributes", "enabled", "created_at", "updated_at") SELECT "id", "tenant_id", "entity_id", "name", "acs_url", "acs_binding", "slo_url", "slo_binding", "cert", "name_id_format", "sign_assertion", "sign_response", "encrypt_assertion", "want_authn_requests_signed", "attribute_mapping_json", "allowed_attributes", "enabled", "created_at", "updated_at" FROM `saml_sps`;--> statement-breakpoint
DROP TABLE `saml_sps`;--> statement-breakpoint
ALTER TABLE `__new_saml_sps` RENAME TO `saml_sps`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `saml_sps_tenant_entity_id_uidx` ON `saml_sps` (`tenant_id`,`entity_id`);--> statement-breakpoint
CREATE INDEX `saml_sps_tenant_idx` ON `saml_sps` (`tenant_id`);
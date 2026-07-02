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

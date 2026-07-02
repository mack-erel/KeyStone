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
CREATE INDEX `user_service_assignments_tenant_service_idx` ON `user_service_assignments` (`tenant_id`,`service_type`,`service_ref_id`);
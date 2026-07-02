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
CREATE UNIQUE INDEX `client_skins_unique` ON `client_skins` (`tenant_id`,`client_type`,`client_ref_id`,`skin_type`);
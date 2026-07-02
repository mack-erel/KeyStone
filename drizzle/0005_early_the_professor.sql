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
CREATE INDEX `user_parts_tenant_idx` ON `user_parts` (`tenant_id`);
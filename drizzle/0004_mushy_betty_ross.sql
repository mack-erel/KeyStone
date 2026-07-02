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
ALTER TABLE `users` ADD `given_name` text;--> statement-breakpoint
ALTER TABLE `users` ADD `family_name` text;--> statement-breakpoint
ALTER TABLE `users` ADD `phone_number` text;--> statement-breakpoint
ALTER TABLE `users` ADD `phone_verified_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `avatar_url` text;--> statement-breakpoint
ALTER TABLE `users` ADD `locale` text DEFAULT 'ko-KR';--> statement-breakpoint
ALTER TABLE `users` ADD `zoneinfo` text DEFAULT 'Asia/Seoul';--> statement-breakpoint
ALTER TABLE `users` ADD `bio` text;--> statement-breakpoint
ALTER TABLE `users` ADD `birthdate` text;
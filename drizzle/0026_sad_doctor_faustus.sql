CREATE TABLE `email_change_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`target_email` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_change_tokens_user_idx` ON `email_change_tokens` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_change_tokens_hash_uidx` ON `email_change_tokens` (`token_hash`);--> statement-breakpoint
ALTER TABLE `users` ADD `pending_email` text;--> statement-breakpoint
ALTER TABLE `users` ADD `pending_email_requested_at` integer;
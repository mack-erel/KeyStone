CREATE TABLE `invite_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invite_tokens_user_idx` ON `invite_tokens` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invite_tokens_hash_uidx` ON `invite_tokens` (`token_hash`);
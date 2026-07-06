CREATE TABLE `email_change_tokens` (
	`id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`token_hash` varchar(255) NOT NULL,
	`target_email` varchar(320) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `email_change_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `email_change_tokens_hash_uidx` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `pending_email` varchar(320);--> statement-breakpoint
ALTER TABLE `users` ADD `pending_email_requested_at` datetime(3);--> statement-breakpoint
ALTER TABLE `email_change_tokens` ADD CONSTRAINT `email_change_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `email_change_tokens_user_idx` ON `email_change_tokens` (`user_id`);
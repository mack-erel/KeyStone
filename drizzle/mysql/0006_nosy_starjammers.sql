CREATE TABLE `invite_tokens` (
	`id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`token_hash` varchar(255) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `invite_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `invite_tokens_hash_uidx` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `invite_tokens` ADD CONSTRAINT `invite_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `invite_tokens_user_idx` ON `invite_tokens` (`user_id`);
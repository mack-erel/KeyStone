ALTER TABLE `credentials` ADD `totp_owner_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_totp_owner_uidx` ON `credentials` (`totp_owner_id`);
ALTER TABLE `credentials` ADD `totp_owner_id` varchar(64);--> statement-breakpoint
ALTER TABLE `credentials` ADD CONSTRAINT `credentials_totp_owner_uidx` UNIQUE(`totp_owner_id`);
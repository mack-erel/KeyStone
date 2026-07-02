ALTER TABLE `users` ADD `username` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_tenant_username_uidx` ON `users` (`tenant_id`,`username`);
DROP INDEX `webauthn_challenges_challenge_uidx`;--> statement-breakpoint
DROP INDEX `webauthn_challenges_expires_idx`;--> statement-breakpoint
ALTER TABLE `webauthn_challenges` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `webauthn_challenges` ADD `user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_challenges_tenant_challenge_uidx` ON `webauthn_challenges` (`tenant_id`,`challenge`);--> statement-breakpoint
CREATE INDEX `webauthn_challenges_tenant_expires_idx` ON `webauthn_challenges` (`tenant_id`,`expires_at`);
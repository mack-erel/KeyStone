CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_challenges_challenge_uidx` ON `webauthn_challenges` (`challenge`);--> statement-breakpoint
CREATE INDEX `webauthn_challenges_expires_idx` ON `webauthn_challenges` (`expires_at`);--> statement-breakpoint
ALTER TABLE `saml_sps` ADD `allowed_attributes` text;
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_oidc_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text,
	`code` text,
	`code_hash` text,
	`code_challenge` text,
	`code_challenge_method` text,
	`redirect_uri` text NOT NULL,
	`scope` text NOT NULL,
	`nonce` text,
	`state` text,
	`acr` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_oidc_grants`("id", "tenant_id", "client_id", "user_id", "session_id", "code", "code_challenge", "code_challenge_method", "redirect_uri", "scope", "nonce", "state", "acr", "expires_at", "used_at", "created_at") SELECT "id", "tenant_id", "client_id", "user_id", "session_id", "code", "code_challenge", "code_challenge_method", "redirect_uri", "scope", "nonce", "state", "acr", "expires_at", "used_at", "created_at" FROM `oidc_grants`;--> statement-breakpoint
DROP TABLE `oidc_grants`;--> statement-breakpoint
ALTER TABLE `__new_oidc_grants` RENAME TO `oidc_grants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_grants_code_uidx` ON `oidc_grants` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_grants_code_hash_uidx` ON `oidc_grants` (`code_hash`);--> statement-breakpoint
CREATE INDEX `oidc_grants_tenant_client_idx` ON `oidc_grants` (`tenant_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `oidc_grants_expires_idx` ON `oidc_grants` (`expires_at`);
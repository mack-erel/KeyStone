ALTER TABLE `oidc_clients` ADD `require_verified_email` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `saml_sps` ADD `require_verified_email` boolean DEFAULT false NOT NULL;
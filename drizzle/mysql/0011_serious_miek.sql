ALTER TABLE `oidc_clients` ADD `allow_all_users` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `saml_sps` ADD `allow_all_users` boolean DEFAULT false NOT NULL;
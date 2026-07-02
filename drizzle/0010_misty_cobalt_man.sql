ALTER TABLE `oidc_clients` ADD `frontchannel_logout_uri` text;--> statement-breakpoint
ALTER TABLE `oidc_clients` ADD `frontchannel_logout_session_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `oidc_clients` ADD `backchannel_logout_uri` text;--> statement-breakpoint
ALTER TABLE `oidc_clients` ADD `backchannel_logout_session_required` integer DEFAULT false NOT NULL;
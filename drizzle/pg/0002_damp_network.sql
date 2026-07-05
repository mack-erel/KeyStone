ALTER TABLE "credentials" ADD COLUMN "totp_owner_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_totp_owner_uidx" ON "credentials" USING btree ("totp_owner_id");
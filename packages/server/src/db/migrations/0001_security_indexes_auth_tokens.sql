CREATE TYPE "public"."auth_token_type" AS ENUM('email_verification', 'password_reset');--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "auth_token_type" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_configs" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_configs" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_token_hash_idx" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_id_type_idx" ON "auth_tokens" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX "media_assets_user_id_idx" ON "media_assets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_connections_user_platform_idx" ON "platform_connections" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX "post_batches_user_created_idx" ON "post_batches" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "post_items_batch_id_idx" ON "post_items" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "post_items_media_asset_id_idx" ON "post_items" USING btree ("media_asset_id");--> statement-breakpoint
CREATE INDEX "post_targets_post_item_id_idx" ON "post_targets" USING btree ("post_item_id");--> statement-breakpoint
CREATE INDEX "post_targets_publish_target_id_idx" ON "post_targets" USING btree ("publish_target_id");--> statement-breakpoint
CREATE INDEX "post_targets_status_scheduled_at_idx" ON "post_targets" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "post_targets_created_at_id_idx" ON "post_targets" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "publish_targets_platform_active_idx" ON "publish_targets" USING btree ("platform","is_active");--> statement-breakpoint
CREATE INDEX "publish_targets_connection_idx" ON "publish_targets" USING btree ("platform_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_token_hash_idx" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "schedule_runs_target_started_idx" ON "schedule_runs" USING btree ("publish_target_id","started_at");
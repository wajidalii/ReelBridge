CREATE TYPE "public"."connection_platform" AS ENUM('facebook', 'google');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."media_asset_status" AS ENUM('uploaded', 'validated', 'failed_validation');--> statement-breakpoint
CREATE TYPE "public"."post_batch_status" AS ENUM('draft', 'scheduling', 'active', 'completed');--> statement-breakpoint
CREATE TYPE "public"."post_target_status" AS ENUM('pending', 'queued', 'uploading', 'native_scheduled', 'awaiting_app_managed_publish', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "public"."publish_target_platform" AS ENUM('facebook_page', 'instagram_business', 'youtube_channel');--> statement-breakpoint
CREATE TYPE "public"."schedule_run_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."schedule_run_triggered_by" AS ENUM('cron', 'manual');--> statement-breakpoint
CREATE TYPE "public"."token_source" AS ENUM('oauth', 'manual');--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"original_filename" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"duration_seconds" integer,
	"width" integer,
	"height" integer,
	"status" "media_asset_status" DEFAULT 'uploaded' NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_cents" integer NOT NULL,
	"max_targets" integer NOT NULL,
	"max_posts_per_month" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" "connection_platform" NOT NULL,
	"external_account_id" text NOT NULL,
	"display_name" text NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"access_token_iv" text NOT NULL,
	"access_token_tag" text NOT NULL,
	"refresh_token_ciphertext" text,
	"refresh_token_iv" text,
	"refresh_token_tag" text,
	"token_expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "post_batch_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"default_caption" text NOT NULL,
	"default_title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_item_id" uuid NOT NULL,
	"publish_target_id" uuid NOT NULL,
	"caption_override" text,
	"title_override" text,
	"scheduled_at" timestamp with time zone,
	"status" "post_target_status" DEFAULT 'pending' NOT NULL,
	"platform_post_id" text,
	"permalink_url" text,
	"last_error" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"platform_connection_id" uuid NOT NULL,
	"platform" "publish_target_platform" NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"timezone" text,
	"access_token_ciphertext" text,
	"access_token_iv" text,
	"access_token_tag" text,
	"token_source" "token_source" DEFAULT 'oauth' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_validated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"publish_target_id" uuid NOT NULL,
	"daily_slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_schedule_days" integer DEFAULT 28 NOT NULL,
	"min_lead_minutes" integer DEFAULT 15 NOT NULL,
	"cron_expression" text NOT NULL,
	"next_run_at" timestamp with time zone,
	"is_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "schedule_configs_publish_target_id_unique" UNIQUE("publish_target_id")
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"publish_target_id" uuid NOT NULL,
	"triggered_by" "schedule_run_triggered_by" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"items_considered" integer DEFAULT 0 NOT NULL,
	"items_scheduled" integer DEFAULT 0 NOT NULL,
	"items_leftover" integer DEFAULT 0 NOT NULL,
	"status" "schedule_run_status" DEFAULT 'running' NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_end" timestamp with time zone,
	CONSTRAINT "subscriptions_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_connections" ADD CONSTRAINT "platform_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_batches" ADD CONSTRAINT "post_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_items" ADD CONSTRAINT "post_items_batch_id_post_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."post_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_items" ADD CONSTRAINT "post_items_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_post_item_id_post_items_id_fk" FOREIGN KEY ("post_item_id") REFERENCES "public"."post_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_publish_target_id_publish_targets_id_fk" FOREIGN KEY ("publish_target_id") REFERENCES "public"."publish_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD CONSTRAINT "publish_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD CONSTRAINT "publish_targets_platform_connection_id_platform_connections_id_fk" FOREIGN KEY ("platform_connection_id") REFERENCES "public"."platform_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_configs" ADD CONSTRAINT "schedule_configs_publish_target_id_publish_targets_id_fk" FOREIGN KEY ("publish_target_id") REFERENCES "public"."publish_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_publish_target_id_publish_targets_id_fk" FOREIGN KEY ("publish_target_id") REFERENCES "public"."publish_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publish_targets_user_platform_external_id_idx" ON "publish_targets" USING btree ("user_id","platform","external_id");
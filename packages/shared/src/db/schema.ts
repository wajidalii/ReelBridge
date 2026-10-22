import { randomUUID } from 'node:crypto';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

function uuidPk() {
  return uuid('id')
    .primaryKey()
    .$defaultFn(() => randomUUID());
}

// --- enums -----------------------------------------------------------------

export const connectionPlatformEnum = pgEnum('connection_platform', ['facebook', 'google']);

export const publishTargetPlatformEnum = pgEnum('publish_target_platform', [
  'facebook_page',
  'instagram_business',
  'youtube_channel',
]);

export const connectionStatusEnum = pgEnum('connection_status', ['active', 'expired', 'revoked']);

export const tokenSourceEnum = pgEnum('token_source', ['oauth', 'manual']);

export const mediaAssetStatusEnum = pgEnum('media_asset_status', [
  'uploaded',
  'validated',
  'failed_validation',
]);

export const postBatchStatusEnum = pgEnum('post_batch_status', [
  'draft',
  'scheduling',
  'active',
  'completed',
]);

export const postTargetStatusEnum = pgEnum('post_target_status', [
  'pending',
  'queued',
  'uploading',
  'native_scheduled',
  'awaiting_app_managed_publish',
  'published',
  'failed',
]);

export const scheduleRunTriggeredByEnum = pgEnum('schedule_run_triggered_by', ['cron', 'manual']);

export const scheduleRunStatusEnum = pgEnum('schedule_run_status', [
  'running',
  'completed',
  'failed',
]);

export const authTokenTypeEnum = pgEnum('auth_token_type', [
  'email_verification',
  'password_reset',
]);

// --- tables ------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuidPk(),
  email: varchar('email', { length: 320 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  /** null until the signup verification link is followed (issue #38). */
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Every /refresh and /logout looks a token up by hash; without this the
    // lookup is a sequential scan that grows with every login ever made.
    uniqueIndex('refresh_tokens_token_hash_idx').on(table.tokenHash),
    index('refresh_tokens_user_id_idx').on(table.userId),
    index('refresh_tokens_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * Single-use, expiring tokens for signup email verification and password
 * reset (issue #38). Only the SHA-256 of the raw token is stored — same
 * reasoning as refresh_tokens: high-entropy random values don't need bcrypt.
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: authTokenTypeEnum('type').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('auth_tokens_token_hash_idx').on(table.tokenHash),
    index('auth_tokens_user_id_type_idx').on(table.userId, table.type),
  ],
);

export const platformConnections = pgTable(
  'platform_connections',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: connectionPlatformEnum('platform').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    displayName: text('display_name').notNull(),
    accessTokenCiphertext: text('access_token_ciphertext').notNull(),
    accessTokenIv: text('access_token_iv').notNull(),
    accessTokenTag: text('access_token_tag').notNull(),
    refreshTokenCiphertext: text('refresh_token_ciphertext'),
    refreshTokenIv: text('refresh_token_iv'),
    refreshTokenTag: text('refresh_token_tag'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    scopes: text('scopes').array().notNull().default([]),
    status: connectionStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('platform_connections_user_platform_idx').on(table.userId, table.platform)],
);

export const publishTargets = pgTable(
  'publish_targets',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platformConnectionId: uuid('platform_connection_id')
      .notNull()
      .references(() => platformConnections.id, { onDelete: 'cascade' }),
    platform: publishTargetPlatformEnum('platform').notNull(),
    externalId: text('external_id').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    timezone: text('timezone'),
    accessTokenCiphertext: text('access_token_ciphertext'),
    accessTokenIv: text('access_token_iv'),
    accessTokenTag: text('access_token_tag'),
    tokenSource: tokenSourceEnum('token_source').notNull().default('oauth'),
    metadata: jsonb('metadata').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('publish_targets_user_platform_external_id_idx').on(
      table.userId,
      table.platform,
      table.externalId,
    ),
    // The health-check sweep and the worker's per-target queue discovery both
    // scan "active targets of platform X" — keep that an index range scan.
    index('publish_targets_platform_active_idx').on(table.platform, table.isActive),
    index('publish_targets_connection_idx').on(table.platformConnectionId),
  ],
);

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    originalFilename: text('original_filename').notNull(),
    storageKey: text('storage_key').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    durationSeconds: integer('duration_seconds'),
    width: integer('width'),
    height: integer('height'),
    status: mediaAssetStatusEnum('status').notNull().default('uploaded'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('media_assets_user_id_idx').on(table.userId)],
);

export const postBatches = pgTable(
  'post_batches',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: postBatchStatusEnum('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('post_batches_user_created_idx').on(table.userId, table.createdAt)],
);

export const postItems = pgTable(
  'post_items',
  {
    id: uuidPk(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => postBatches.id, { onDelete: 'cascade' }),
    mediaAssetId: uuid('media_asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'restrict' }),
    defaultCaption: text('default_caption').notNull(),
    defaultTitle: text('default_title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('post_items_batch_id_idx').on(table.batchId),
    index('post_items_media_asset_id_idx').on(table.mediaAssetId),
  ],
);

export const postTargets = pgTable(
  'post_targets',
  {
    id: uuidPk(),
    postItemId: uuid('post_item_id')
      .notNull()
      .references(() => postItems.id, { onDelete: 'cascade' }),
    publishTargetId: uuid('publish_target_id')
      .notNull()
      .references(() => publishTargets.id, { onDelete: 'cascade' }),
    captionOverride: text('caption_override'),
    titleOverride: text('title_override'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    status: postTargetStatusEnum('status').notNull().default('pending'),
    platformPostId: text('platform_post_id'),
    permalinkUrl: text('permalink_url'),
    lastError: text('last_error'),
    attemptCount: integer('attempt_count').notNull().default(0),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('post_targets_post_item_id_idx').on(table.postItemId),
    index('post_targets_publish_target_id_idx').on(table.publishTargetId),
    // Every cron sweep is a "rows in status X (due by scheduled_at)" query;
    // the posts list is keyset-paginated on (created_at, id).
    index('post_targets_status_scheduled_at_idx').on(table.status, table.scheduledAt),
    index('post_targets_created_at_id_idx').on(table.createdAt, table.id),
  ],
);

export const scheduleConfigs = pgTable('schedule_configs', {
  id: uuidPk(),
  publishTargetId: uuid('publish_target_id')
    .notNull()
    .unique()
    .references(() => publishTargets.id, { onDelete: 'cascade' }),
  /** "HH:mm" strings in `timezone`, e.g. ["09:00", "13:00", "18:00"]. */
  dailySlots: jsonb('daily_slots').notNull().default([]),
  /** IANA zone the daily slots are expressed in (issue #48). */
  timezone: text('timezone').notNull().default('UTC'),
  maxScheduleDays: integer('max_schedule_days').notNull().default(28),
  minLeadMinutes: integer('min_lead_minutes').notNull().default(15),
  cronExpression: text('cron_expression').notNull(),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  isEnabled: boolean('is_enabled').notNull().default(true),
});

export const scheduleRuns = pgTable(
  'schedule_runs',
  {
    id: uuidPk(),
    publishTargetId: uuid('publish_target_id')
      .notNull()
      .references(() => publishTargets.id, { onDelete: 'cascade' }),
    triggeredBy: scheduleRunTriggeredByEnum('triggered_by').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    itemsConsidered: integer('items_considered').notNull().default(0),
    itemsScheduled: integer('items_scheduled').notNull().default(0),
    itemsLeftover: integer('items_leftover').notNull().default(0),
    status: scheduleRunStatusEnum('status').notNull().default('running'),
    errorMessage: text('error_message'),
  },
  (table) => [index('schedule_runs_target_started_idx').on(table.publishTargetId, table.startedAt)],
);

// --- billing stubs (schema only, no Stripe wiring yet) ----------------------

export const plans = pgTable('plans', {
  id: uuidPk(),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  maxTargets: integer('max_targets').notNull(),
  maxPostsPerMonth: integer('max_posts_per_month').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
});

export const subscriptions = pgTable('subscriptions', {
  id: uuidPk(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  planId: uuid('plan_id')
    .notNull()
    .references(() => plans.id, { onDelete: 'restrict' }),
  status: varchar('status', { length: 32 }).notNull().default('active'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
});

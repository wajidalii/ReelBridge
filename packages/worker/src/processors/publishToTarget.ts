import { facebookPageAdapter } from '@reelbridge/platform-facebook';
import { instagramBusinessAdapter } from '@reelbridge/platform-instagram';
import { isQuotaExceededError, youtubeChannelAdapter } from '@reelbridge/platform-youtube';
import type { PlatformAdapter, PublishToTargetJobData, StorageAdapter } from '@reelbridge/shared';
import {
  createStorageAdapterFromEnv,
  decrypt,
  getDb,
  mediaAssets,
  platformConnections,
  postItems,
  postTargets,
  publishTargets,
} from '@reelbridge/shared';
import { DelayedError, type Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { loadGoogleOAuthConfig } from '../googleOAuthConfig.js';

const ADAPTERS_BY_PLATFORM: Partial<Record<string, PlatformAdapter>> = {
  facebook_page: facebookPageAdapter,
  youtube_channel: youtubeChannelAdapter,
  instagram_business: instagramBusinessAdapter,
};

// YouTube's videos.insert bucket resets daily (Google's public quota-cost
// docs don't publish the exact reset instant per project, and re-verifying
// that against this project's own Cloud Console dashboard is a deploy-time
// task, not something this code can check). An hour is a conservative
// middle ground: short enough that a mid-day quota bump or a reset earlier
// than expected isn't sat on for near a full day, long enough that repeated
// attempts don't hammer an exhausted bucket every few seconds the way the
// default exponential backoff (packages/shared/src/queues/publishToTarget.ts)
// would.
const YOUTUBE_QUOTA_BACKOFF_MS = 60 * 60 * 1000;

// Generous enough that Meta's fetcher has plenty of headroom to pull the
// file even under retry/backoff on their end, short enough that a leaked
// URL isn't reachable indefinitely.
const INSTAGRAM_SIGNED_URL_TTL_SECONDS = 30 * 60;

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

type PublishTargetRow = typeof publishTargets.$inferSelect;
type PlatformConnectionRow = typeof platformConnections.$inferSelect;
type MediaAssetRow = typeof mediaAssets.$inferSelect;

/**
 * Builds the adapter-specific `target.metadata` payload — including reading
 * the media asset from storage, since *how* it's handed to the adapter
 * differs per platform (a raw buffer vs. a signed URL neither Facebook nor
 * YouTube need).
 *
 * - Facebook Page tokens live per-target and are long-lived, so they're
 *   decrypted directly.
 * - YouTube uses the *connection's* refresh token instead (publish_targets
 *   stays tokenless for youtube_channel rows — upsertGoogleConnection.ts)
 *   and mints a fresh access token per upload rather than trusting a
 *   per-target one that may already be stale by the time a queued job runs.
 * - Instagram has no token of its own at all: publishing is authenticated
 *   with the *linked Facebook Page's* token (shared/instagramTargets.ts),
 *   looked up via `publish_targets.metadata.linkedFacebookPageId`. It also
 *   doesn't accept a raw binary body (TDD.md §1.2) — Meta's servers pull the
 *   video from a URL, so this generates a short-lived signed storage URL
 *   instead of reading the file into memory at all.
 */
async function buildTargetMetadata(
  db: ReturnType<typeof getDb>,
  storage: StorageAdapter,
  publishTarget: PublishTargetRow,
  platformConnection: PlatformConnectionRow,
  mediaAsset: MediaAssetRow,
): Promise<Record<string, unknown>> {
  if (publishTarget.platform === 'instagram_business') {
    const linkedFacebookPageId = (
      publishTarget.metadata as { linkedFacebookPageId?: string } | null
    )?.linkedFacebookPageId;
    if (!linkedFacebookPageId) {
      throw new Error(
        `publish_targets row ${publishTarget.id} has no linkedFacebookPageId in metadata`,
      );
    }
    const [fbTarget] = await db
      .select()
      .from(publishTargets)
      .where(
        and(
          eq(publishTargets.userId, publishTarget.userId),
          eq(publishTargets.platform, 'facebook_page'),
          eq(publishTargets.externalId, linkedFacebookPageId),
        ),
      );
    if (!fbTarget?.accessTokenCiphertext || !fbTarget.accessTokenIv || !fbTarget.accessTokenTag) {
      throw new Error(`linked Facebook Page ${linkedFacebookPageId} is missing an access token`);
    }
    const accessToken = decrypt({
      ciphertext: fbTarget.accessTokenCiphertext,
      iv: fbTarget.accessTokenIv,
      tag: fbTarget.accessTokenTag,
    });
    const videoUrl = await storage.getSignedUrl(
      mediaAsset.storageKey,
      INSTAGRAM_SIGNED_URL_TTL_SECONDS,
    );
    return { accessToken, videoUrl };
  }

  if (publishTarget.platform === 'youtube_channel') {
    if (
      !platformConnection.refreshTokenCiphertext ||
      !platformConnection.refreshTokenIv ||
      !platformConnection.refreshTokenTag
    ) {
      throw new Error(
        `platform_connections row ${platformConnection.id} is missing a refresh token`,
      );
    }
    const refreshToken = decrypt({
      ciphertext: platformConnection.refreshTokenCiphertext,
      iv: platformConnection.refreshTokenIv,
      tag: platformConnection.refreshTokenTag,
    });
    const buffer = await streamToBuffer(await storage.read(mediaAsset.storageKey));
    return { refreshToken, oauthConfig: loadGoogleOAuthConfig(), media: { buffer } };
  }

  if (
    !publishTarget.accessTokenCiphertext ||
    !publishTarget.accessTokenIv ||
    !publishTarget.accessTokenTag
  ) {
    throw new Error(`publish_targets row ${publishTarget.id} is missing an access token`);
  }
  const accessToken = decrypt({
    ciphertext: publishTarget.accessTokenCiphertext,
    iv: publishTarget.accessTokenIv,
    tag: publishTarget.accessTokenTag,
  });
  const buffer = await streamToBuffer(await storage.read(mediaAsset.storageKey));
  return { accessToken, media: { buffer } };
}

/**
 * Reads a due post_targets row, resolves its media/tokens per platform, calls
 * the matching platform adapter's publish(), and writes the result back —
 * the "worker does the real publish work, never the API" boundary in
 * practice. facebook_page, youtube_channel, and instagram_business are all
 * wired.
 *
 * `token` is BullMQ's lock token for this job, passed automatically by the
 * Worker that invokes this processor — needed to hand the job back to
 * `moveToDelayed` on a quota-exceeded YouTube upload (see below) without
 * losing the lock BullMQ requires for that call.
 */
export async function processPublishToTarget(
  job: Job<PublishToTargetJobData>,
  token?: string,
): Promise<void> {
  const db = getDb();
  const { postTargetId } = job.data;

  const [row] = await db
    .select({
      postTarget: postTargets,
      publishTarget: publishTargets,
      postItem: postItems,
      mediaAsset: mediaAssets,
      platformConnection: platformConnections,
    })
    .from(postTargets)
    .innerJoin(publishTargets, eq(postTargets.publishTargetId, publishTargets.id))
    .innerJoin(postItems, eq(postTargets.postItemId, postItems.id))
    .innerJoin(mediaAssets, eq(postItems.mediaAssetId, mediaAssets.id))
    .innerJoin(platformConnections, eq(publishTargets.platformConnectionId, platformConnections.id))
    .where(eq(postTargets.id, postTargetId));

  if (!row) {
    throw new Error(`post_targets row ${postTargetId} not found`);
  }
  const { postTarget, publishTarget, postItem, mediaAsset, platformConnection } = row;

  const adapter = ADAPTERS_BY_PLATFORM[publishTarget.platform];
  if (!adapter) {
    throw new Error(`No platform adapter registered for ${publishTarget.platform}`);
  }

  await db
    .update(postTargets)
    .set({ status: 'uploading', updatedAt: new Date() })
    .where(eq(postTargets.id, postTargetId));

  const caption = postTarget.captionOverride ?? postItem.defaultCaption;
  const title = postTarget.titleOverride ?? postItem.defaultTitle ?? undefined;

  try {
    // Metadata-building (storage read/signed-URL + token decryption) lives
    // inside this try too, not just adapter.publish() — a missing/
    // undecryptable token or an unreadable media object is exactly as much a
    // publish failure as the platform API rejecting the call, and needs the
    // same post_targets 'failed' + last_error treatment rather than leaving
    // the row stuck at 'uploading' with BullMQ silently retrying.
    const storage = createStorageAdapterFromEnv();
    const metadata = await buildTargetMetadata(
      db,
      storage,
      publishTarget,
      platformConnection,
      mediaAsset,
    );

    const result = await adapter.publish(
      {
        externalId: publishTarget.externalId,
        displayName: publishTarget.displayName,
        metadata,
      },
      {
        mediaAssetId: mediaAsset.id,
        storageKey: mediaAsset.storageKey,
        originalFilename: mediaAsset.originalFilename,
        fileSizeBytes: mediaAsset.fileSizeBytes,
        durationSeconds: mediaAsset.durationSeconds ?? undefined,
        width: mediaAsset.width ?? undefined,
        height: mediaAsset.height ?? undefined,
      },
      { caption, title },
      postTarget.scheduledAt ?? undefined,
    );

    await db
      .update(postTargets)
      .set({
        platformPostId: result.platformPostId,
        status: result.status,
        publishedAt: result.status === 'published' ? new Date() : null,
        permalinkUrl: result.permalinkUrl ?? null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(postTargets.id, postTargetId));
  } catch (error) {
    if (isQuotaExceededError(error)) {
      // Exhausting YouTube's 100/day videos.insert bucket isn't a per-item
      // failure — the video and caption are fine, the *account* is just out
      // of room until the bucket resets. Marking this row 'failed' (and
      // spending one of its limited BullMQ attempts on a backoff measured in
      // seconds) would be misleading and wasteful, so instead: log it as a
      // distinct, observable event; leave post_targets 'queued' with an
      // explanatory last_error rather than 'failed'; and hand the job back
      // to BullMQ as intentionally delayed (moveToDelayed + DelayedError,
      // not a thrown failure) so it doesn't consume one of the job's normal
      // retry attempts.
      console.warn('[youtube-quota-exceeded]', {
        postTargetId,
        publishTargetId: publishTarget.id,
        retryAt: new Date(Date.now() + YOUTUBE_QUOTA_BACKOFF_MS).toISOString(),
      });
      await db
        .update(postTargets)
        .set({
          status: 'queued',
          lastError:
            'YouTube daily upload quota exceeded — will retry automatically once it resets.',
          updatedAt: new Date(),
        })
        .where(eq(postTargets.id, postTargetId));
      await job.moveToDelayed(Date.now() + YOUTUBE_QUOTA_BACKOFF_MS, token);
      throw new DelayedError();
    }

    await db
      .update(postTargets)
      .set({
        status: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
        attemptCount: postTarget.attemptCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(postTargets.id, postTargetId));
    throw error; // rethrow so BullMQ applies its own retry/backoff policy
  }
}

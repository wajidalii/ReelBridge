import { facebookPageAdapter } from '@reelbridge/platform-facebook';
import type { PlatformAdapter, PublishToTargetJobData } from '@reelbridge/shared';
import {
  createStorageAdapterFromEnv,
  decrypt,
  getDb,
  mediaAssets,
  postItems,
  postTargets,
  publishTargets,
} from '@reelbridge/shared';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';

const ADAPTERS_BY_PLATFORM: Partial<Record<string, PlatformAdapter>> = {
  facebook_page: facebookPageAdapter,
};

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Reads a due post_targets row, fetches its media from storage, calls the
 * matching platform adapter's publish(), and writes the result back —
 * the "worker does the real publish work, never the API" boundary in practice.
 * Only facebook_page is wired today; Instagram/YouTube adapters land in their
 * own milestones and will register here the same way.
 */
export async function processPublishToTarget(job: Job<PublishToTargetJobData>): Promise<void> {
  const db = getDb();
  const { postTargetId } = job.data;

  const [row] = await db
    .select({
      postTarget: postTargets,
      publishTarget: publishTargets,
      postItem: postItems,
      mediaAsset: mediaAssets,
    })
    .from(postTargets)
    .innerJoin(publishTargets, eq(postTargets.publishTargetId, publishTargets.id))
    .innerJoin(postItems, eq(postTargets.postItemId, postItems.id))
    .innerJoin(mediaAssets, eq(postItems.mediaAssetId, mediaAssets.id))
    .where(eq(postTargets.id, postTargetId));

  if (!row) {
    throw new Error(`post_targets row ${postTargetId} not found`);
  }
  const { postTarget, publishTarget, postItem, mediaAsset } = row;

  const adapter = ADAPTERS_BY_PLATFORM[publishTarget.platform];
  if (!adapter) {
    throw new Error(`No platform adapter registered for ${publishTarget.platform}`);
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

  const storage = createStorageAdapterFromEnv();
  const mediaStream = await storage.read(mediaAsset.storageKey);
  const buffer = await streamToBuffer(mediaStream);

  await db
    .update(postTargets)
    .set({ status: 'uploading', updatedAt: new Date() })
    .where(eq(postTargets.id, postTargetId));

  const caption = postTarget.captionOverride ?? postItem.defaultCaption;

  try {
    const result = await adapter.publish(
      {
        externalId: publishTarget.externalId,
        displayName: publishTarget.displayName,
        metadata: { accessToken, media: { buffer } },
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
      { caption, title: postTarget.titleOverride ?? undefined },
      postTarget.scheduledAt ?? undefined,
    );

    await db
      .update(postTargets)
      .set({
        platformPostId: result.platformPostId,
        status: result.status,
        publishedAt: result.status === 'published' ? new Date() : null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(postTargets.id, postTargetId));
  } catch (error) {
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

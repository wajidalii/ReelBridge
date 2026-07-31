import { facebookPageAdapter } from '@reelbridge/platform-facebook';
import type { PlatformAdapter, PollStatusJobData } from '@reelbridge/shared';
import { decrypt, getDb, postTargets, publishTargets } from '@reelbridge/shared';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';

const ADAPTERS_BY_PLATFORM: Partial<Record<string, PlatformAdapter>> = {
  facebook_page: facebookPageAdapter,
};

/**
 * Re-checks a post_targets row that's native_scheduled (the platform holds the
 * future publish; we're only confirming it actually happened) and backfills
 * permalink_url/status. A no-op if the row moved on (e.g. already published by
 * a prior poll, or a retry replaced it) — safe to run redundantly.
 */
export async function processPollStatus(job: Job<PollStatusJobData>): Promise<void> {
  const db = getDb();
  const { postTargetId } = job.data;

  const [row] = await db
    .select({ postTarget: postTargets, publishTarget: publishTargets })
    .from(postTargets)
    .innerJoin(publishTargets, eq(postTargets.publishTargetId, publishTargets.id))
    .where(eq(postTargets.id, postTargetId));

  if (!row) {
    throw new Error(`post_targets row ${postTargetId} not found`);
  }
  const { postTarget, publishTarget } = row;

  if (postTarget.status !== 'native_scheduled') {
    return;
  }
  if (!postTarget.platformPostId) {
    throw new Error(
      `post_targets row ${postTargetId} is native_scheduled but has no platformPostId`,
    );
  }

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

  const result = await adapter.checkStatus(
    {
      externalId: publishTarget.externalId,
      displayName: publishTarget.displayName,
      metadata: { accessToken },
    },
    postTarget.platformPostId,
  );

  if (result.status === 'published') {
    await db
      .update(postTargets)
      .set({
        status: 'published',
        permalinkUrl: result.permalinkUrl ?? null,
        publishedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(postTargets.id, postTargetId));
  } else if (result.status === 'failed') {
    await db
      .update(postTargets)
      .set({
        status: 'failed',
        lastError: result.errorMessage ?? 'Unknown failure reported by platform',
        updatedAt: new Date(),
      })
      .where(eq(postTargets.id, postTargetId));
  }
  // 'pending': no change — the next scheduled sweep will re-check.
}

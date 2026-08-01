import { discoverPageInstagramAccount, validatePageToken } from '@reelbridge/platform-facebook';
import type { InstagramDiscoveryOutcome, HealthCheckJobData } from '@reelbridge/shared';
import { decrypt, getDb, publishTargets, reconcileInstagramTarget } from '@reelbridge/shared';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';

/**
 * Proactively confirms a target's stored token still works, rather than only
 * discovering it's dead when a scheduled post fails (SAAS_PLAN.md's flagged
 * risk — page tokens show expires_at: 0 but that's contingent on the app/token
 * staying valid). Flips is_active=false on failure so the dashboard can show a
 * "needs reconnect" banner; always updates last_validated_at either way so
 * "when did we last check" is never a mystery.
 */
export async function processHealthCheck(job: Job<HealthCheckJobData>): Promise<void> {
  const db = getDb();
  const { publishTargetId } = job.data;

  const [target] = await db
    .select()
    .from(publishTargets)
    .where(eq(publishTargets.id, publishTargetId));
  if (!target) {
    throw new Error(`publish_targets row ${publishTargetId} not found`);
  }

  if (target.platform !== 'facebook_page') {
    return; // only Facebook Page health checks are implemented so far
  }

  if (!target.accessTokenCiphertext || !target.accessTokenIv || !target.accessTokenTag) {
    await db
      .update(publishTargets)
      .set({ isActive: false, lastValidatedAt: new Date() })
      .where(eq(publishTargets.id, publishTargetId));
    return;
  }

  const accessToken = decrypt({
    ciphertext: target.accessTokenCiphertext,
    iv: target.accessTokenIv,
    tag: target.accessTokenTag,
  });

  const result = await validatePageToken(target.externalId, accessToken);

  await db
    .update(publishTargets)
    .set({ isActive: result !== null, lastValidatedAt: new Date() })
    .where(eq(publishTargets.id, publishTargetId));

  // Re-running Instagram discovery is scoped to a manual "Run now" re-check
  // (issue #32), not the hourly cron sweep — doing it unconditionally would
  // triple the Graph API calls made for every active Page every hour, with no
  // user action behind it, risking Meta's rate limits for no real benefit.
  if (result === null || job.data.trigger !== 'manual') {
    return;
  }

  // A Page whose linked IG account changes — newly linked, unlinked, replaced,
  // or downgraded to Personal — converges to current reality here the same
  // way the connect flow does, instead of only ever being resolved once.
  const discovery = await discoverPageInstagramAccount(target.externalId, accessToken).catch(
    (): InstagramDiscoveryOutcome => ({ status: 'not_linked' }),
  );
  await reconcileInstagramTarget({
    userId: target.userId,
    platformConnectionId: target.platformConnectionId,
    facebookPageId: target.externalId,
    discovery,
  });
}

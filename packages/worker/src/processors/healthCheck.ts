import { discoverPageInstagramAccount, validatePageToken } from '@reelbridge/platform-facebook';
import { checkInstagramAccountHealth } from '@reelbridge/platform-instagram';
import { checkYouTubeConnectionHealth } from '@reelbridge/platform-youtube';
import type { InstagramDiscoveryOutcome, HealthCheckJobData } from '@reelbridge/shared';
import {
  decrypt,
  getDb,
  getLogger,
  healthCheckResultsTotal,
  platformConnections,
  publishTargets,
  reconcileInstagramTarget,
} from '@reelbridge/shared';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { loadGoogleOAuthConfig } from '../googleOAuthConfig.js';

type TargetRow = typeof publishTargets.$inferSelect;

function decryptTargetToken(target: TargetRow): string | null {
  if (!target.accessTokenCiphertext || !target.accessTokenIv || !target.accessTokenTag) {
    return null;
  }
  return decrypt({
    ciphertext: target.accessTokenCiphertext,
    iv: target.accessTokenIv,
    tag: target.accessTokenTag,
  });
}

async function recordResult(
  target: TargetRow,
  ok: boolean,
  errorMessage: string | null,
): Promise<void> {
  const metadata = { ...(target.metadata as Record<string, unknown>) };
  if (errorMessage) metadata.lastHealthError = errorMessage;
  else delete metadata.lastHealthError;
  await getDb()
    .update(publishTargets)
    .set({ isActive: ok, lastValidatedAt: new Date(), metadata })
    .where(eq(publishTargets.id, target.id));
  healthCheckResultsTotal.inc({ platform: target.platform, result: ok ? 'healthy' : 'unhealthy' });
}

/**
 * Proactively confirms a target's stored credentials still work, rather than
 * only discovering they're dead when a scheduled post fails (SAAS_PLAN.md's
 * flagged risk — page tokens show expires_at: 0 but that's contingent on the
 * app/token staying valid). Covers all three target types (issue #36):
 *
 * - facebook_page: `GET /{page_id}` with the stored Page token.
 * - instagram_business: the *linked Page's* token must still read the IG
 *   account, and the account must still be Business/Creator.
 * - youtube_channel: the connection's Google refresh token must still mint an
 *   access token — `invalid_grant` means the user revoked access in their
 *   Google Account settings, which flips the connection to `revoked`.
 *
 * Flips is_active=false on failure so the dashboard can show a "needs
 * reconnect" banner; always updates last_validated_at either way so "when did
 * we last check" is never a mystery. Transient platform errors (5xx) leave
 * is_active untouched: a Graph API blip isn't evidence the token is dead.
 */
export async function processHealthCheck(job: Job<HealthCheckJobData>): Promise<void> {
  const db = getDb();
  const log = getLogger().child({ component: 'health-check', jobId: job.id });
  const { publishTargetId } = job.data;

  const [target] = await db
    .select()
    .from(publishTargets)
    .where(eq(publishTargets.id, publishTargetId));
  if (!target) {
    throw new Error(`publish_targets row ${publishTargetId} not found`);
  }

  if (target.platform === 'facebook_page') {
    const accessToken = decryptTargetToken(target);
    if (!accessToken) {
      await recordResult(target, false, 'No access token stored for this Page');
      return;
    }
    const result = await validatePageToken(target.externalId, accessToken);
    await recordResult(
      target,
      result !== null,
      result === null ? 'Facebook rejected the stored Page token' : null,
    );

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
    return;
  }

  if (target.platform === 'instagram_business') {
    const linkedPageId = (target.metadata as { linkedFacebookPageId?: string } | null)
      ?.linkedFacebookPageId;
    const [page] = linkedPageId
      ? await db
          .select()
          .from(publishTargets)
          .where(
            and(
              eq(publishTargets.userId, target.userId),
              eq(publishTargets.platform, 'facebook_page'),
              eq(publishTargets.externalId, linkedPageId),
            ),
          )
      : [];
    const pageToken = page ? decryptTargetToken(page) : null;
    if (!pageToken) {
      await recordResult(
        target,
        false,
        'The Facebook Page this Instagram account is linked to is no longer connected',
      );
      return;
    }
    const health = await checkInstagramAccountHealth(target.externalId, pageToken);
    if (health.status === 'healthy') {
      await recordResult(target, true, null);
    } else if (health.status === 'personal_account') {
      await recordResult(
        target,
        false,
        'This Instagram account was switched to a Personal account; convert it back to Business/Creator',
      );
    } else {
      await recordResult(target, false, health.reason);
    }
    return;
  }

  if (target.platform === 'youtube_channel') {
    const [connection] = await db
      .select()
      .from(platformConnections)
      .where(eq(platformConnections.id, target.platformConnectionId));
    if (
      !connection?.refreshTokenCiphertext ||
      !connection.refreshTokenIv ||
      !connection.refreshTokenTag
    ) {
      await recordResult(target, false, 'No Google refresh token stored for this channel');
      return;
    }
    const refreshToken = decrypt({
      ciphertext: connection.refreshTokenCiphertext,
      iv: connection.refreshTokenIv,
      tag: connection.refreshTokenTag,
    });
    const health = await checkYouTubeConnectionHealth(loadGoogleOAuthConfig(), refreshToken);
    if (health.status === 'healthy') {
      if (connection.status !== 'active') {
        await db
          .update(platformConnections)
          .set({ status: 'active', updatedAt: new Date() })
          .where(eq(platformConnections.id, connection.id));
      }
      await recordResult(target, true, null);
    } else if (health.status === 'revoked') {
      // One Google connection may back several channels — the revocation is
      // recorded once on the connection and every channel under it is flagged.
      await db
        .update(platformConnections)
        .set({ status: 'revoked', updatedAt: new Date() })
        .where(eq(platformConnections.id, connection.id));
      await db
        .update(publishTargets)
        .set({ isActive: false, lastValidatedAt: new Date() })
        .where(eq(publishTargets.platformConnectionId, connection.id));
      await recordResult(target, false, `Google access was revoked: ${health.reason}`);
    } else {
      log.warn({ publishTargetId, reason: health.reason }, 'youtube health check inconclusive');
      await db
        .update(publishTargets)
        .set({ lastValidatedAt: new Date() })
        .where(eq(publishTargets.id, publishTargetId));
      healthCheckResultsTotal.inc({ platform: target.platform, result: 'inconclusive' });
    }
    return;
  }
}

import {
  getDb,
  getLogger,
  postTargets,
  postTargetsByStatus,
  publishTargets,
} from '@reelbridge/shared';
import { count, eq } from 'drizzle-orm';
import { deleteStaleAuthTokens } from '../modules/auth/authTokens.js';
import { deleteStaleRefreshTokens } from '../modules/auth/refreshTokens.js';

/**
 * Daily: drop expired/used auth tokens and expired/long-revoked refresh
 * tokens. Both tables only ever grew before this; neither row type has any
 * value once expired (a revoked refresh token is unusable with or without
 * its row — revocation is enforced by the row's absence from the "valid"
 * query, and expiry by expires_at).
 */
export async function runTokenHousekeeping(): Promise<void> {
  const graceDays = Number(process.env.TOKEN_HOUSEKEEPING_GRACE_DAYS ?? 7);
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);
  const removedRefresh = await deleteStaleRefreshTokens(cutoff);
  await deleteStaleAuthTokens(cutoff);
  getLogger().info({ removedRefresh }, 'token housekeeping done');
}

/** Samples post_targets counts per (platform, status) into the Prometheus gauge (issue #39). */
export async function sampleQueueDepthMetrics(): Promise<void> {
  const rows = await getDb()
    .select({ platform: publishTargets.platform, status: postTargets.status, value: count() })
    .from(postTargets)
    .innerJoin(publishTargets, eq(postTargets.publishTargetId, publishTargets.id))
    .groupBy(publishTargets.platform, postTargets.status);
  postTargetsByStatus.reset();
  for (const row of rows) {
    postTargetsByStatus.set({ platform: row.platform, status: row.status }, Number(row.value));
  }
}

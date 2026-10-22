import {
  getDb,
  mediaAssets,
  platformConnections,
  postBatches,
  postItems,
  postTargets,
  publishTargets,
} from '@reelbridge/shared';
import { and, asc, count, desc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';

export const dashboardRouter = Router();

/**
 * One round-trip summary for the home screen: per-platform × status counts
 * (never blended across platforms — PROJECT.md's observability NFR applies
 * to the user-facing view as well), the next few upcoming publishes, the
 * latest failures, and targets needing attention.
 */
dashboardRouter.get('/', requireAuth, async (req, res) => {
  const db = getDb();
  const userId = req.userId!;

  const [countsRows, targets, upcoming, recentFailures, batchCount] = await Promise.all([
    db
      .select({ platform: publishTargets.platform, status: postTargets.status, value: count() })
      .from(postTargets)
      .innerJoin(postItems, eq(postTargets.postItemId, postItems.id))
      .innerJoin(postBatches, eq(postItems.batchId, postBatches.id))
      .innerJoin(publishTargets, eq(postTargets.publishTargetId, publishTargets.id))
      .where(eq(postBatches.userId, userId))
      .groupBy(publishTargets.platform, postTargets.status),
    // A target whose owning connection is revoked/expired needs attention
    // even if its own is_active flag hasn't been flipped yet (the health
    // sweep converges them, but the dashboard shouldn't wait an hour).
    db
      .select({
        id: publishTargets.id,
        platform: publishTargets.platform,
        displayName: publishTargets.displayName,
        isActive: publishTargets.isActive,
        lastValidatedAt: publishTargets.lastValidatedAt,
        connectionStatus: platformConnections.status,
      })
      .from(publishTargets)
      .leftJoin(
        platformConnections,
        eq(publishTargets.platformConnectionId, platformConnections.id),
      )
      .where(eq(publishTargets.userId, userId)),
    db
      .select({
        id: postTargets.id,
        platform: publishTargets.platform,
        targetDisplayName: publishTargets.displayName,
        originalFilename: mediaAssets.originalFilename,
        scheduledAt: postTargets.scheduledAt,
        status: postTargets.status,
      })
      .from(postTargets)
      .innerJoin(postItems, eq(postTargets.postItemId, postItems.id))
      .innerJoin(postBatches, eq(postItems.batchId, postBatches.id))
      .innerJoin(publishTargets, eq(postTargets.publishTargetId, publishTargets.id))
      .leftJoin(mediaAssets, eq(postItems.mediaAssetId, mediaAssets.id))
      .where(
        and(
          eq(postBatches.userId, userId),
          isNotNull(postTargets.scheduledAt),
          gt(postTargets.scheduledAt, new Date()),
          inArray(postTargets.status, [
            'native_scheduled',
            'awaiting_app_managed_publish',
            'queued',
          ]),
        ),
      )
      .orderBy(asc(postTargets.scheduledAt))
      .limit(5),
    db
      .select({
        id: postTargets.id,
        platform: publishTargets.platform,
        targetDisplayName: publishTargets.displayName,
        originalFilename: mediaAssets.originalFilename,
        lastError: postTargets.lastError,
        updatedAt: postTargets.updatedAt,
      })
      .from(postTargets)
      .innerJoin(postItems, eq(postTargets.postItemId, postItems.id))
      .innerJoin(postBatches, eq(postItems.batchId, postBatches.id))
      .innerJoin(publishTargets, eq(postTargets.publishTargetId, publishTargets.id))
      .leftJoin(mediaAssets, eq(postItems.mediaAssetId, mediaAssets.id))
      .where(and(eq(postBatches.userId, userId), eq(postTargets.status, 'failed')))
      .orderBy(desc(postTargets.updatedAt))
      .limit(5),
    db.select({ value: count() }).from(postBatches).where(eq(postBatches.userId, userId)),
  ]);

  const countsByPlatform: Record<string, Record<string, number>> = {};
  for (const row of countsRows) {
    countsByPlatform[row.platform] ??= {};
    countsByPlatform[row.platform]![row.status] = Number(row.value);
  }

  const healthy = (t: (typeof targets)[number]) =>
    t.isActive && (t.connectionStatus === null || t.connectionStatus === 'active');

  res.json({
    targets: {
      total: targets.length,
      active: targets.filter(healthy).length,
      needsAttention: targets.filter((t) => !healthy(t)),
      byPlatform: targets.reduce<Record<string, number>>((acc, t) => {
        acc[t.platform] = (acc[t.platform] ?? 0) + 1;
        return acc;
      }, {}),
    },
    posts: { countsByPlatform },
    batches: { total: Number(batchCount[0]?.value ?? 0) },
    upcoming,
    recentFailures,
  });
});

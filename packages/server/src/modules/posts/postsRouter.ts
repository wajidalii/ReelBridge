import {
  getDb,
  mediaAssets,
  postBatches,
  postItems,
  postTargetStatusEnum,
  postTargets,
  publishTargetPlatformEnum,
  publishTargets,
  retryPublishToTarget,
} from '@reelbridge/shared';
import { and, desc, eq, gte, lte, lt, or, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { assertPostTargetOwnership } from '../ownership/assertOwnership.js';
import { requireOwnership } from '../ownership/middleware.js';

export const postsRouter = Router();

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const listQuerySchema = z.object({
  platform: z.enum(publishTargetPlatformEnum.enumValues).optional(),
  status: z.enum(postTargetStatusEnum.enumValues).optional(),
  target: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

/** Opaque keyset-pagination cursor: (created_at, id) of the last row on the previous page. */
function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const separatorIndex = cursor.indexOf('|');
  if (separatorIndex === -1) return null;
  const createdAt = new Date(cursor.slice(0, separatorIndex));
  const id = cursor.slice(separatorIndex + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

// Unified cross-platform post list backing the status dashboard (#26):
// filterable by platform/status/target/date range, keyset-paginated on
// (created_at, id) descending rather than offset-paginated, since the
// acceptance criteria specifically call out performance for a large number
// of items — an OFFSET would force Postgres to walk and discard every row
// ahead of the page on each request.
postsRouter.get('/', requireAuth, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters' });
    return;
  }
  const { platform, status, target, from, to, cursor, limit } = parsed.data;
  const pageSize = limit ?? DEFAULT_PAGE_SIZE;

  const conditions: SQL[] = [eq(postBatches.userId, req.userId!)];
  if (platform) conditions.push(eq(publishTargets.platform, platform));
  if (status) conditions.push(eq(postTargets.status, status));
  if (target) conditions.push(eq(postTargets.publishTargetId, target));
  if (from) conditions.push(gte(postTargets.createdAt, new Date(from)));
  if (to) conditions.push(lte(postTargets.createdAt, new Date(to)));

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) {
      res.status(400).json({ error: 'Invalid cursor' });
      return;
    }
    conditions.push(
      or(
        lt(postTargets.createdAt, decoded.createdAt),
        and(eq(postTargets.createdAt, decoded.createdAt), lt(postTargets.id, decoded.id))!,
      )!,
    );
  }

  const rows = await getDb()
    .select({
      id: postTargets.id,
      postItemId: postTargets.postItemId,
      batchId: postItems.batchId,
      mediaAssetId: postItems.mediaAssetId,
      originalFilename: mediaAssets.originalFilename,
      publishTargetId: postTargets.publishTargetId,
      platform: publishTargets.platform,
      targetDisplayName: publishTargets.displayName,
      captionOverride: postTargets.captionOverride,
      defaultCaption: postItems.defaultCaption,
      titleOverride: postTargets.titleOverride,
      defaultTitle: postItems.defaultTitle,
      status: postTargets.status,
      scheduledAt: postTargets.scheduledAt,
      publishedAt: postTargets.publishedAt,
      platformPostId: postTargets.platformPostId,
      permalinkUrl: postTargets.permalinkUrl,
      lastError: postTargets.lastError,
      attemptCount: postTargets.attemptCount,
      createdAt: postTargets.createdAt,
      updatedAt: postTargets.updatedAt,
    })
    .from(postTargets)
    .innerJoin(postItems, eq(postTargets.postItemId, postItems.id))
    .innerJoin(postBatches, eq(postItems.batchId, postBatches.id))
    .innerJoin(publishTargets, eq(postTargets.publishTargetId, publishTargets.id))
    .leftJoin(mediaAssets, eq(postItems.mediaAssetId, mediaAssets.id))
    .where(and(...conditions))
    .orderBy(desc(postTargets.createdAt), desc(postTargets.id))
    .limit(pageSize + 1);

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page[page.length - 1];

  res.json({
    posts: page.map((row) => ({
      id: row.id,
      postItemId: row.postItemId,
      batchId: row.batchId,
      mediaAssetId: row.mediaAssetId,
      originalFilename: row.originalFilename,
      publishTargetId: row.publishTargetId,
      platform: row.platform,
      targetDisplayName: row.targetDisplayName,
      caption: row.captionOverride ?? row.defaultCaption,
      title: row.titleOverride ?? row.defaultTitle,
      status: row.status,
      scheduledAt: row.scheduledAt,
      publishedAt: row.publishedAt,
      platformPostId: row.platformPostId,
      permalinkUrl: row.permalinkUrl,
      lastError: row.lastError,
      attemptCount: row.attemptCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  });
});

// One-click retry (design.md §7): reuses the existing media asset and
// post_target row — only re-enqueues the publish job and resets status/
// last_error, no re-upload. Only 'failed' rows are eligible: anything still
// pending/queued/in-flight already has a job (or will get one from
// POST /:id/publish), and retrying a published row makes no sense.
postsRouter.post(
  '/:id/retry',
  requireAuth,
  requireOwnership('id', assertPostTargetOwnership),
  async (req, res) => {
    const db = getDb();
    const postTargetId = req.params.id as string;

    const [row] = await db
      .select({ postTarget: postTargets, publishTarget: publishTargets })
      .from(postTargets)
      .innerJoin(publishTargets, eq(postTargets.publishTargetId, publishTargets.id))
      .where(eq(postTargets.id, postTargetId));

    if (!row) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }
    if (row.postTarget.status !== 'failed') {
      res.status(400).json({ error: 'Only failed posts can be retried' });
      return;
    }

    await retryPublishToTarget(row.publishTarget.platform, row.publishTarget.externalId, {
      postTargetId,
    });

    const [updated] = await db
      .update(postTargets)
      .set({ status: 'queued', lastError: null, updatedAt: new Date() })
      .where(eq(postTargets.id, postTargetId))
      .returning();

    res.json(updated);
  },
);

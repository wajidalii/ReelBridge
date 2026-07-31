import { getDb, postBatches, postItems, postTargets, publishTargets } from '@reelbridge/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import {
  assertBatchOwnership,
  assertMediaAssetOwnership,
  assertTargetOwnership,
  ResourceNotFoundError,
} from '../ownership/assertOwnership.js';
import { requireOwnership } from '../ownership/middleware.js';

export const batchesRouter = Router();

const createBatchSchema = z.object({ name: z.string().min(1) });

batchesRouter.post('/', requireAuth, async (req, res) => {
  const parsed = createBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const [batch] = await getDb()
    .insert(postBatches)
    .values({ userId: req.userId!, name: parsed.data.name })
    .returning();
  res.status(201).json(batch);
});

batchesRouter.get(
  '/:id',
  requireAuth,
  requireOwnership('id', assertBatchOwnership),
  async (req, res) => {
    const db = getDb();
    const batchId = req.params.id as string;

    const [batch] = await db.select().from(postBatches).where(eq(postBatches.id, batchId));
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }

    const items = await db.select().from(postItems).where(eq(postItems.batchId, batchId));
    const itemIds = items.map((item) => item.id);
    const targets =
      itemIds.length > 0
        ? await db.select().from(postTargets).where(inArray(postTargets.postItemId, itemIds))
        : [];

    res.json({
      ...batch,
      items: items.map((item) => ({
        ...item,
        targets: targets.filter((target) => target.postItemId === item.id),
      })),
    });
  },
);

const createItemSchema = z.object({
  media_asset_id: z.string().uuid(),
  default_caption: z.string().min(1),
  default_title: z.string().optional(),
});

batchesRouter.post(
  '/:id/items',
  requireAuth,
  requireOwnership('id', assertBatchOwnership),
  async (req, res) => {
    const parsed = createItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'media_asset_id and default_caption are required' });
      return;
    }

    try {
      await assertMediaAssetOwnership(req.userId!, parsed.data.media_asset_id);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        res.status(404).json({ error: 'Media asset not found' });
        return;
      }
      throw error;
    }

    const [item] = await getDb()
      .insert(postItems)
      .values({
        batchId: req.params.id as string,
        mediaAssetId: parsed.data.media_asset_id,
        defaultCaption: parsed.data.default_caption,
        defaultTitle: parsed.data.default_title,
      })
      .returning();
    res.status(201).json(item);
  },
);

// Approximate, publicly documented per-platform limits — not a substitute for
// each platform rejecting an oversized request; this is an early UX check.
const CAPTION_MAX_LENGTHS: Partial<Record<string, number>> = {
  facebook_page: 63206,
  instagram_business: 2200,
  youtube_channel: 5000,
};
const YOUTUBE_TITLE_MAX_LENGTH = 100;

const assignTargetsSchema = z.object({
  targets: z
    .array(
      z.object({
        publish_target_id: z.string().uuid(),
        caption_override: z.string().optional(),
        title_override: z.string().optional(),
        scheduled_at: z.string().datetime().optional(),
      }),
    )
    .min(1),
});

batchesRouter.post(
  '/:id/items/:itemId/targets',
  requireAuth,
  requireOwnership('id', assertBatchOwnership),
  async (req, res) => {
    const parsed = assignTargetsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'targets (non-empty array) is required' });
      return;
    }

    const db = getDb();
    const batchId = req.params.id as string;
    const itemId = req.params.itemId as string;

    const [item] = await db
      .select()
      .from(postItems)
      .where(and(eq(postItems.id, itemId), eq(postItems.batchId, batchId)));
    if (!item) {
      res.status(404).json({ error: 'Post item not found in this batch' });
      return;
    }

    const created: (typeof postTargets.$inferSelect)[] = [];
    const rejected: Array<{ publish_target_id: string; error: string }> = [];

    for (const target of parsed.data.targets) {
      try {
        await assertTargetOwnership(req.userId!, target.publish_target_id);
      } catch (error) {
        if (error instanceof ResourceNotFoundError) {
          rejected.push({
            publish_target_id: target.publish_target_id,
            error: 'Target not found',
          });
          continue;
        }
        throw error;
      }

      const [publishTarget] = await db
        .select()
        .from(publishTargets)
        .where(eq(publishTargets.id, target.publish_target_id));

      const caption = target.caption_override ?? item.defaultCaption;
      const maxCaptionLength = publishTarget
        ? CAPTION_MAX_LENGTHS[publishTarget.platform]
        : undefined;
      if (maxCaptionLength && caption.length > maxCaptionLength) {
        rejected.push({
          publish_target_id: target.publish_target_id,
          error: `Caption exceeds the ${maxCaptionLength}-character limit for this platform`,
        });
        continue;
      }

      if (publishTarget?.platform === 'youtube_channel') {
        const title = target.title_override ?? item.defaultTitle ?? caption.split('\n')[0];
        if (title && title.length > YOUTUBE_TITLE_MAX_LENGTH) {
          rejected.push({
            publish_target_id: target.publish_target_id,
            error: `Title exceeds the ${YOUTUBE_TITLE_MAX_LENGTH}-character YouTube limit`,
          });
          continue;
        }
      }

      const [inserted] = await db
        .insert(postTargets)
        .values({
          postItemId: itemId,
          publishTargetId: target.publish_target_id,
          captionOverride: target.caption_override,
          titleOverride: target.title_override,
          scheduledAt: target.scheduled_at ? new Date(target.scheduled_at) : undefined,
        })
        .returning();
      if (inserted) {
        created.push(inserted);
      }
    }

    res.status(created.length > 0 ? 201 : 400).json({ created, rejected });
  },
);

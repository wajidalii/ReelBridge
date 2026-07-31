import {
  generateSchedulingSlots,
  getDb,
  mediaAssets,
  PLATFORM_CAPABILITIES,
  postBatches,
  postItems,
  postTargets,
  publishTargets,
  type ValidationSeverity,
} from '@reelbridge/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import {
  assertBatchOwnership,
  assertMediaAssetOwnership,
  assertPostItemOwnership,
  assertTargetOwnership,
  ResourceNotFoundError,
} from '../ownership/assertOwnership.js';
import { requireOwnership } from '../ownership/middleware.js';
import { PREVIEW_ADAPTERS_BY_PLATFORM } from './platformAdapters.js';

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

    // Joined in so the target-assignment UI (#24) can show each item's
    // filename/thumbnail-relevant metadata without an extra request per item.
    const mediaAssetIds = [...new Set(items.map((item) => item.mediaAssetId))];
    const mediaRows =
      mediaAssetIds.length > 0
        ? await db.select().from(mediaAssets).where(inArray(mediaAssets.id, mediaAssetIds))
        : [];
    const mediaById = new Map(mediaRows.map((media) => [media.id, media]));

    res.json({
      ...batch,
      items: items.map((item) => ({
        ...item,
        media: mediaById.get(item.mediaAssetId) ?? null,
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

// Lets the batch upload UI's "Remove" action fully undo adding a video to a
// batch — without this, a post_item's `ON DELETE RESTRICT` on media_asset_id
// means DELETE /api/media/:id alone 409s once an item references it, leaving
// a video the user thought they removed still attached to the batch.
batchesRouter.delete(
  '/:id/items/:itemId',
  requireAuth,
  requireOwnership('id', assertBatchOwnership),
  async (req, res) => {
    const batchId = req.params.id as string;
    const itemId = req.params.itemId as string;

    try {
      await assertPostItemOwnership(req.userId!, itemId);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        res.status(404).json({ error: 'Post item not found' });
        return;
      }
      throw error;
    }

    const db = getDb();
    const [item] = await db
      .select({ id: postItems.id })
      .from(postItems)
      .where(and(eq(postItems.id, itemId), eq(postItems.batchId, batchId)));
    if (!item) {
      res.status(404).json({ error: 'Post item not found in this batch' });
      return;
    }

    await db.delete(postItems).where(eq(postItems.id, itemId));
    res.status(204).send();
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

const autoDistributeSchema = z.object({
  publish_target_id: z.string().uuid(),
  item_ids: z.array(z.string().uuid()).min(1),
  daily_slot_times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1),
});

// Dry-run, like /preview below: computes where each item *would* land if the
// user auto-distributes, without writing anything — the client still submits
// the resulting scheduled_at per item via POST .../targets to actually save
// it, same as an explicit-datetime assignment would. `:id` here is only an
// authorization boundary (requireOwnership below), not a data relationship —
// item_ids are never looked up against this (or any) batch, since the
// response is pure arithmetic over their count and never touches their
// content.
batchesRouter.post(
  '/:id/auto-distribute',
  requireAuth,
  requireOwnership('id', assertBatchOwnership),
  async (req, res) => {
    const parsed = autoDistributeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'publish_target_id, item_ids, and daily_slot_times (HH:mm) are required',
      });
      return;
    }

    try {
      await assertTargetOwnership(req.userId!, parsed.data.publish_target_id);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        res.status(404).json({ error: 'Target not found' });
        return;
      }
      throw error;
    }

    const [target] = await getDb()
      .select()
      .from(publishTargets)
      .where(eq(publishTargets.id, parsed.data.publish_target_id));
    if (!target) {
      res.status(404).json({ error: 'Target not found' });
      return;
    }

    const capabilities = PLATFORM_CAPABILITIES[target.platform];
    const { scheduledTimes, leftoverCount } = generateSchedulingSlots({
      pendingItemCount: parsed.data.item_ids.length,
      dailySlotTimes: parsed.data.daily_slot_times,
      timezone: target.timezone ?? 'UTC',
      minLeadMinutes: capabilities.minScheduleLeadMinutes,
      maxLeadDays: capabilities.maxScheduleLeadDays,
    });

    const assignments = parsed.data.item_ids
      .slice(0, scheduledTimes.length)
      .map((itemId, index) => ({ item_id: itemId, scheduled_at: scheduledTimes[index] }));

    res.json({ assignments, leftoverCount });
  },
);

interface PreviewWarning {
  code: string;
  severity: ValidationSeverity;
  affectedField: string;
  message: string;
}

interface PreviewRow {
  postItemId: string;
  mediaAssetId: string;
  originalFilename: string | null;
  publishTargetId: string;
  platform: string | null;
  targetDisplayName: string | null;
  resolvedCaption: string;
  resolvedTitle: string | null;
  scheduledAt: Date | null;
  /** null when the target/adapter couldn't be resolved at all (see warnings). */
  schedulingMode: 'native_scheduled' | 'awaiting_app_managed_publish' | null;
  warnings: PreviewWarning[];
  blocking: boolean;
}

// Dry-run: resolves every (media, target, time, caption) combination for a
// batch with zero DB writes. Safe to call repeatedly while the batch is still
// in draft — nothing here mutates state, so it's naturally idempotent.
batchesRouter.get(
  '/:id/preview',
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

    const mediaAssetIds = [...new Set(items.map((item) => item.mediaAssetId))];
    const mediaRows =
      mediaAssetIds.length > 0
        ? await db.select().from(mediaAssets).where(inArray(mediaAssets.id, mediaAssetIds))
        : [];
    const mediaById = new Map(mediaRows.map((media) => [media.id, media]));

    const publishTargetIds = [...new Set(targets.map((target) => target.publishTargetId))];
    const publishTargetRows =
      publishTargetIds.length > 0
        ? await db.select().from(publishTargets).where(inArray(publishTargets.id, publishTargetIds))
        : [];
    const publishTargetById = new Map(publishTargetRows.map((target) => [target.id, target]));

    const rows: PreviewRow[] = [];

    for (const item of items) {
      const media = mediaById.get(item.mediaAssetId);
      const itemTargets = targets.filter((target) => target.postItemId === item.id);

      for (const target of itemTargets) {
        const publishTarget = publishTargetById.get(target.publishTargetId);
        const adapter = publishTarget
          ? PREVIEW_ADAPTERS_BY_PLATFORM[publishTarget.platform]
          : undefined;

        const resolvedCaption = target.captionOverride ?? item.defaultCaption;
        const resolvedTitle =
          target.titleOverride ??
          item.defaultTitle ??
          (publishTarget?.platform === 'youtube_channel'
            ? resolvedCaption.split('\n')[0]
            : undefined);

        const warnings: PreviewWarning[] = [];

        if (!publishTarget) {
          warnings.push({
            code: 'target_not_found',
            severity: 'blocking',
            affectedField: 'target',
            message: 'This target no longer exists.',
          });
        } else if (!publishTarget.isActive) {
          warnings.push({
            code: 'target_needs_reconnect',
            severity: 'blocking',
            affectedField: 'target',
            message: 'This target needs to be reconnected before it can be scheduled.',
          });
        }

        if (!media) {
          warnings.push({
            code: 'media_not_found',
            severity: 'blocking',
            affectedField: 'media',
            message: 'The media asset for this item no longer exists.',
          });
        } else if (adapter) {
          warnings.push(
            ...adapter.validateMediaConstraints({
              mediaAssetId: media.id,
              storageKey: media.storageKey,
              originalFilename: media.originalFilename,
              fileSizeBytes: media.fileSizeBytes,
              durationSeconds: media.durationSeconds ?? undefined,
              width: media.width ?? undefined,
              height: media.height ?? undefined,
            }),
          );
        }

        rows.push({
          postItemId: item.id,
          mediaAssetId: item.mediaAssetId,
          originalFilename: media?.originalFilename ?? null,
          publishTargetId: target.publishTargetId,
          platform: publishTarget?.platform ?? null,
          targetDisplayName: publishTarget?.displayName ?? null,
          resolvedCaption,
          resolvedTitle: resolvedTitle ?? null,
          scheduledAt: target.scheduledAt,
          schedulingMode: adapter
            ? adapter.capabilities.nativeScheduling
              ? 'native_scheduled'
              : 'awaiting_app_managed_publish'
            : null,
          warnings,
          blocking: warnings.some((warning) => warning.severity === 'blocking'),
        });
      }
    }

    res.json({ batchId, batchName: batch.name, rows });
  },
);

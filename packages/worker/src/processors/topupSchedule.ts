import {
  enqueuePublishToTarget,
  generateSchedulingSlots,
  getDb,
  getLogger,
  PLATFORM_CAPABILITIES,
  postBatches,
  postItems,
  postTargets,
  publishTargets,
  scheduleConfigs,
  scheduleRuns,
  type TopupScheduleJobData,
} from '@reelbridge/shared';
import type { Job } from 'bullmq';
import { and, asc, eq, isNull } from 'drizzle-orm';

/**
 * Recurring "evergreen topup" processor (issue #48, generalizing the
 * Facebook-only CLI's schedule_reels.py): for one publish target, takes its
 * backlog — post_targets rows still `pending` with no scheduled_at — and
 * fills the rolling window ahead with slots at the configured daily times,
 * oldest batch first. Items that don't fit stay pending for the next run,
 * exactly like the CLI's "leftovers wait for the next run".
 *
 * Natively-scheduled platforms (Facebook, YouTube) get their publish job
 * enqueued immediately: the upload happens now and the platform holds the
 * publish moment. App-managed platforms (Instagram) are only *dated* here
 * and sit in awaiting_app_managed_publish for the due-job sweep — the same
 * split POST /api/batches/:id/publish makes.
 */
export async function processTopupSchedule(job: Job<TopupScheduleJobData>): Promise<void> {
  const db = getDb();
  const log = getLogger().child({ component: 'topup-schedule', jobId: job.id });
  const { publishTargetId, triggeredBy } = job.data;

  const [row] = await db
    .select({ target: publishTargets, config: scheduleConfigs })
    .from(scheduleConfigs)
    .innerJoin(publishTargets, eq(scheduleConfigs.publishTargetId, publishTargets.id))
    .where(eq(scheduleConfigs.publishTargetId, publishTargetId));
  if (!row) {
    log.warn({ publishTargetId }, 'topup requested for a target with no schedule config');
    return;
  }
  const { target, config } = row;

  const [run] = await db.insert(scheduleRuns).values({ publishTargetId, triggeredBy }).returning();
  if (!run) throw new Error('failed to insert schedule_runs row');

  try {
    if (!target.isActive) {
      throw new Error('Target is inactive (needs reconnect); nothing scheduled');
    }

    const backlog = await db
      .select({ id: postTargets.id, createdAt: postTargets.createdAt })
      .from(postTargets)
      .innerJoin(postItems, eq(postTargets.postItemId, postItems.id))
      .innerJoin(postBatches, eq(postItems.batchId, postBatches.id))
      .where(
        and(
          eq(postTargets.publishTargetId, publishTargetId),
          eq(postTargets.status, 'pending'),
          isNull(postTargets.scheduledAt),
          eq(postBatches.userId, target.userId),
        ),
      )
      .orderBy(asc(postBatches.createdAt), asc(postItems.createdAt), asc(postTargets.createdAt));

    const capabilities = PLATFORM_CAPABILITIES[target.platform];
    const { scheduledTimes } = generateSchedulingSlots({
      pendingItemCount: backlog.length,
      dailySlotTimes: config.dailySlots as string[],
      timezone: config.timezone,
      minLeadMinutes: Math.max(config.minLeadMinutes, capabilities.minScheduleLeadMinutes ?? 0),
      maxLeadDays: config.maxScheduleDays,
    });

    // Slots already taken by rows scheduled in earlier runs are skipped so
    // two runs never double-book the same daily time.
    const taken = new Set(
      (
        await db
          .select({ scheduledAt: postTargets.scheduledAt })
          .from(postTargets)
          .where(
            and(
              eq(postTargets.publishTargetId, publishTargetId),
              // any still-upcoming row counts, whatever its status
            ),
          )
      )
        .map((r) => r.scheduledAt?.getTime())
        .filter((t): t is number => t !== undefined && t > Date.now()),
    );
    const freeSlots = scheduledTimes.filter((slot) => !taken.has(slot.getTime()));

    let scheduled = 0;
    for (const [index, slot] of freeSlots.entries()) {
      const item = backlog[index];
      if (!item) break;

      if (capabilities.nativeScheduling) {
        await db
          .update(postTargets)
          .set({ scheduledAt: slot, status: 'queued', updatedAt: new Date() })
          .where(and(eq(postTargets.id, item.id), eq(postTargets.status, 'pending')));
        await enqueuePublishToTarget(target.platform, target.externalId, { postTargetId: item.id });
      } else {
        await db
          .update(postTargets)
          .set({ scheduledAt: slot, status: 'awaiting_app_managed_publish', updatedAt: new Date() })
          .where(and(eq(postTargets.id, item.id), eq(postTargets.status, 'pending')));
      }
      scheduled += 1;
    }

    await db
      .update(scheduleRuns)
      .set({
        finishedAt: new Date(),
        status: 'completed',
        itemsConsidered: backlog.length,
        itemsScheduled: scheduled,
        itemsLeftover: backlog.length - scheduled,
      })
      .where(eq(scheduleRuns.id, run.id));
    await db
      .update(scheduleConfigs)
      .set({ lastRunAt: new Date() })
      .where(eq(scheduleConfigs.publishTargetId, publishTargetId));

    log.info(
      { publishTargetId, platform: target.platform, considered: backlog.length, scheduled },
      'topup run completed',
    );
  } catch (error) {
    await db
      .update(scheduleRuns)
      .set({
        finishedAt: new Date(),
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      .where(eq(scheduleRuns.id, run.id));
    throw error;
  }
}

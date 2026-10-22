import { enqueueTopupSchedule, getDb, scheduleConfigs } from '@reelbridge/shared';
import { and, eq, lte } from 'drizzle-orm';
import { computeNextRunAt } from '../modules/targets/targetsRouter.js';

/**
 * Recurring topup trigger (issue #48): every enabled schedule_configs row
 * whose next_run_at has arrived gets one topup job enqueued and its
 * next_run_at advanced — claimed with UPDATE … RETURNING so concurrent API
 * replicas don't double-enqueue (jobId dedupe in enqueueTopupSchedule is the
 * second line of defence). The job itself (worker/processors/topupSchedule)
 * does the slot assignment.
 */
export async function enqueueDueScheduleConfigJobs(): Promise<void> {
  const db = getDb();
  const now = new Date();

  const due = await db
    .select({
      publishTargetId: scheduleConfigs.publishTargetId,
      cronExpression: scheduleConfigs.cronExpression,
      nextRunAt: scheduleConfigs.nextRunAt,
    })
    .from(scheduleConfigs)
    .where(and(eq(scheduleConfigs.isEnabled, true), lte(scheduleConfigs.nextRunAt, now)));

  for (const config of due) {
    const [claimed] = await db
      .update(scheduleConfigs)
      .set({ nextRunAt: computeNextRunAt(config.cronExpression, now) })
      .where(
        and(
          eq(scheduleConfigs.publishTargetId, config.publishTargetId),
          eq(scheduleConfigs.isEnabled, true),
          // Only the replica that sees the still-unadvanced next_run_at wins.
          config.nextRunAt ? eq(scheduleConfigs.nextRunAt, config.nextRunAt) : undefined,
        ),
      )
      .returning({ publishTargetId: scheduleConfigs.publishTargetId });
    if (!claimed) continue;
    await enqueueTopupSchedule({ publishTargetId: claimed.publishTargetId, triggeredBy: 'cron' });
  }
}

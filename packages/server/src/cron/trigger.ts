import cron, { type ScheduledTask } from 'node-cron';

export type DueJobsEnqueuer = () => Promise<void>;

/**
 * Ticks on a schedule and calls the provided callback to enqueue due jobs.
 * Deliberately dumb: it must never perform the actual publish work itself —
 * all real work and retry/backoff logic lives in BullMQ workers
 * (packages/worker). The callback wiring the actual "what's due" DB query
 * lands with the batch/schedule-config modules (Bulk Batch and Fan-Out UX
 * milestone); this is the trigger scaffolding it will plug into.
 */
export function startScheduleTrigger(
  enqueueDueJobs: DueJobsEnqueuer,
  cronExpression = '*/5 * * * *',
): ScheduledTask {
  return cron.schedule(cronExpression, () => {
    enqueueDueJobs().catch((error: unknown) => {
      console.error('Schedule trigger failed to enqueue due jobs:', error);
    });
  });
}

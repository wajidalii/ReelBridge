import { getLogger, sweepRunsTotal } from '@reelbridge/shared';
import cron, { type ScheduledTask } from 'node-cron';

export type DueJobsEnqueuer = () => Promise<void>;

/**
 * Ticks on a schedule and calls the provided callback to enqueue due jobs.
 * Deliberately dumb: it must never perform the actual publish work itself —
 * all real work and retry/backoff logic lives in BullMQ workers
 * (packages/worker). Overlapping ticks are skipped: if one sweep is still
 * running when the next tick fires (slow DB, big backlog), the tick is
 * dropped rather than stacking concurrent sweeps on top of each other.
 */
export function startScheduleTrigger(
  enqueueDueJobs: DueJobsEnqueuer,
  cronExpression = '*/5 * * * *',
  name = enqueueDueJobs.name || 'sweep',
): ScheduledTask {
  let running = false;
  return cron.schedule(cronExpression, () => {
    if (running) {
      sweepRunsTotal.inc({ sweep: name, outcome: 'skipped_overlap' });
      return;
    }
    running = true;
    enqueueDueJobs()
      .then(() => sweepRunsTotal.inc({ sweep: name, outcome: 'ok' }))
      .catch((error: unknown) => {
        sweepRunsTotal.inc({ sweep: name, outcome: 'error' });
        getLogger().error(
          { err: error, sweep: name },
          'schedule trigger failed to enqueue due jobs',
        );
        console.error('Schedule trigger failed to enqueue due jobs:', error);
      })
      .finally(() => {
        running = false;
      });
  });
}

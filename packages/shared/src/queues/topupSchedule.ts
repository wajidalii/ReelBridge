import type { Job, Processor } from 'bullmq';
import { DEFAULT_JOB_RETENTION } from './jobOptions.js';
import { getOrCreateWorker, getQueue } from './registry.js';

/**
 * Recurring "evergreen topup" (issue #48): one job per (target, run) that
 * assigns scheduled times to that target's unscheduled backlog. Writes only
 * to Postgres and enqueues per-row publish jobs — it never talks to a
 * platform itself, so a single shared queue is fine (no per-account limiter).
 */
export const TOPUP_SCHEDULE_QUEUE_NAME = 'topup-schedule';

export interface TopupScheduleJobData {
  publishTargetId: string;
  triggeredBy: 'cron' | 'manual';
}

export async function enqueueTopupSchedule(
  data: TopupScheduleJobData,
): Promise<Job<TopupScheduleJobData>> {
  const queue = getQueue<TopupScheduleJobData>(TOPUP_SCHEDULE_QUEUE_NAME);
  // One in-flight topup per target: a cron tick and a "Run now" click landing
  // together collapse into a single run rather than double-booking slots.
  return queue.add('topup', data, {
    jobId: `topup-${data.publishTargetId}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    ...DEFAULT_JOB_RETENTION,
  });
}

export function startTopupScheduleWorker(processor: Processor<TopupScheduleJobData>) {
  return getOrCreateWorker<TopupScheduleJobData>(TOPUP_SCHEDULE_QUEUE_NAME, processor, {
    concurrency: 4,
  });
}

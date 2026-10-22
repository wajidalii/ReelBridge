import type { Job, Processor } from 'bullmq';
import { DEFAULT_JOB_RETENTION } from './jobOptions.js';
import { getOrCreateWorker, getQueue } from './registry.js';

/** Read-only checks, not subject to per-account write-rate limits, so one shared queue suffices (same reasoning as poll-status). */
export const HEALTH_CHECK_QUEUE_NAME = 'target-health-check';

export interface HealthCheckJobData {
  publishTargetId: string;
  /**
   * 'manual' (the user's "Run now" revalidate button) vs 'sweep' (the hourly
   * cron trigger). Instagram re-discovery only runs for 'manual' — running it
   * on every sweep would triple the Graph API calls made for every active
   * Facebook Page, every hour, for no reason tied to a user action.
   */
  trigger?: 'manual' | 'sweep';
}

export async function enqueueHealthCheck(
  data: HealthCheckJobData,
): Promise<Job<HealthCheckJobData>> {
  const queue = getQueue<HealthCheckJobData>(HEALTH_CHECK_QUEUE_NAME);
  // Manual re-checks get their own job id so a user's "Revalidate" click is
  // never silently swallowed by a sweep job already queued for that target.
  return queue.add('health-check', data, {
    jobId: `health-${data.trigger === 'manual' ? 'manual' : 'sweep'}-${data.publishTargetId}`,
    priority: data.trigger === 'manual' ? 1 : 10,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: DEFAULT_JOB_RETENTION.removeOnFail,
  });
}

export function startHealthCheckWorker(processor: Processor<HealthCheckJobData>) {
  return getOrCreateWorker<HealthCheckJobData>(HEALTH_CHECK_QUEUE_NAME, processor, {
    concurrency: 5,
  });
}

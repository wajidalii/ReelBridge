import type { Job, Processor } from 'bullmq';
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
  return queue.add('health-check', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

export function startHealthCheckWorker(processor: Processor<HealthCheckJobData>) {
  return getOrCreateWorker<HealthCheckJobData>(HEALTH_CHECK_QUEUE_NAME, processor);
}

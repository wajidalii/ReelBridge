import type { Job, Processor } from 'bullmq';
import { getOrCreateWorker, getQueue } from './registry.js';

/** Read-only checks, not subject to per-account write-rate limits, so one shared queue suffices (same reasoning as poll-status). */
export const HEALTH_CHECK_QUEUE_NAME = 'target-health-check';

export interface HealthCheckJobData {
  publishTargetId: string;
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

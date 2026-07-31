import type { Job, Processor } from 'bullmq';
import type { PlatformType } from '../platform-adapter.js';
import { publishToTargetQueueName } from './keys.js';
import { getOrCreateWorker, getQueue } from './registry.js';

export interface PublishToTargetJobData {
  postTargetId: string;
}

/** Per-(platform, account) limiter values — the actual numbers (e.g. Instagram's 100/24h) are filled in per platform adapter. */
export interface RateLimiterConfig {
  max: number;
  duration: number; // ms
}

export async function enqueuePublishToTarget(
  platform: PlatformType,
  externalAccountOrProjectId: string,
  data: PublishToTargetJobData,
): Promise<Job<PublishToTargetJobData>> {
  const queue = getQueue<PublishToTargetJobData>(
    publishToTargetQueueName(platform, externalAccountOrProjectId),
  );
  return queue.add('publish', data, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

export function startPublishToTargetWorker(
  platform: PlatformType,
  externalAccountOrProjectId: string,
  processor: Processor<PublishToTargetJobData>,
  limiter: RateLimiterConfig,
) {
  const name = publishToTargetQueueName(platform, externalAccountOrProjectId);
  return getOrCreateWorker<PublishToTargetJobData>(name, processor, { limiter });
}

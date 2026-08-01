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
  // jobId pinned to postTargetId so a second call for the same row (a UI
  // double-click, a client retry after a network blip, a re-run of the
  // publish loop) dedupes against BullMQ's existing job rather than queuing
  // a second real publish attempt.
  return queue.add('publish', data, {
    jobId: data.postTargetId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

/**
 * Re-queues a post_targets row that previously failed. A plain
 * enqueuePublishToTarget call won't do this on its own: BullMQ's `add` is a
 * no-op against an existing jobId (see the pinning note above), so a job
 * that already ran to failure needs `job.retry()` to move it back to
 * waiting — only falling back to a fresh `add` when no job exists at all
 * (e.g. it was removed, or this row was never actually enqueued).
 */
export async function retryPublishToTarget(
  platform: PlatformType,
  externalAccountOrProjectId: string,
  data: PublishToTargetJobData,
): Promise<Job<PublishToTargetJobData>> {
  const queue = getQueue<PublishToTargetJobData>(
    publishToTargetQueueName(platform, externalAccountOrProjectId),
  );
  const existing = await queue.getJob(data.postTargetId);
  if (!existing) {
    return enqueuePublishToTarget(platform, externalAccountOrProjectId, data);
  }

  const state = await existing.getState();
  if (state === 'failed' || state === 'completed') {
    await existing.retry(state, { resetAttemptsMade: true });
  }
  // Any other state (waiting/active/delayed) already means this row is
  // in flight — leave it alone rather than disturbing it.
  return existing;
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

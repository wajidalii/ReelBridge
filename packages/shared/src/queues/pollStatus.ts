import type { Job, Processor } from 'bullmq';
import { DEFAULT_JOB_RETENTION } from './jobOptions.js';
import { POLL_STATUS_QUEUE_NAME } from './keys.js';
import { getOrCreateWorker, getQueue } from './registry.js';

export interface PollStatusJobData {
  postTargetId: string;
}

export async function enqueuePollStatus(data: PollStatusJobData): Promise<Job<PollStatusJobData>> {
  const queue = getQueue<PollStatusJobData>(POLL_STATUS_QUEUE_NAME);
  // jobId pinned per row: the sweep runs every few minutes and re-selects
  // every still-native_scheduled row, so without dedupe a slow platform
  // check would let poll jobs for the same row pile up in Redis.
  return queue.add('poll', data, {
    jobId: `poll-${data.postTargetId}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: true,
    removeOnFail: DEFAULT_JOB_RETENTION.removeOnFail,
  });
}

export function startPollStatusWorker(processor: Processor<PollStatusJobData>) {
  return getOrCreateWorker<PollStatusJobData>(POLL_STATUS_QUEUE_NAME, processor, {
    concurrency: 5,
  });
}

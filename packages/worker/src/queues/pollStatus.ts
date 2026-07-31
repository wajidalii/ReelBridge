import type { Job, Processor } from 'bullmq';
import { POLL_STATUS_QUEUE_NAME } from './keys.js';
import { getOrCreateWorker, getQueue } from './registry.js';

export interface PollStatusJobData {
  postTargetId: string;
}

export async function enqueuePollStatus(data: PollStatusJobData): Promise<Job<PollStatusJobData>> {
  const queue = getQueue<PollStatusJobData>(POLL_STATUS_QUEUE_NAME);
  return queue.add('poll', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
  });
}

export function startPollStatusWorker(processor: Processor<PollStatusJobData>) {
  return getOrCreateWorker<PollStatusJobData>(POLL_STATUS_QUEUE_NAME, processor);
}

import type { JobsOptions } from 'bullmq';

/**
 * Without these, BullMQ keeps every completed/failed job forever and Redis
 * memory grows linearly with the number of posts ever published. Completed
 * jobs are only useful for a short debugging window; failed ones are kept
 * longer (and capped by count) because the dashboard's retry path looks the
 * job up by id to call `job.retry()` (see publishToTarget.ts).
 */
export const DEFAULT_JOB_RETENTION: Pick<JobsOptions, 'removeOnComplete' | 'removeOnFail'> = {
  removeOnComplete: { age: 24 * 60 * 60, count: 5000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 20000 },
};

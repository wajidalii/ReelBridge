import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

/**
 * Proves the "always-on scheduler" no longer depends on any one machine being
 * up: kill a worker mid-job, restart it (a second worker), and confirm BullMQ
 * redelivers the stalled job rather than losing it. Requires a real Redis —
 * skips with a warning if REDIS_URL isn't set/reachable (e.g. run via
 * `docker compose up redis` or in CI, which provides a Redis service container).
 */
async function isRedisReachable(url: string): Promise<boolean> {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

describe('BullMQ queue durability', () => {
  it('redelivers a stalled job to a new worker after the original worker dies mid-processing', async () => {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl || !(await isRedisReachable(redisUrl))) {
      console.warn(
        'Skipping durability test: REDIS_URL not set or unreachable (run `docker compose up redis`)',
      );
      return;
    }

    const queueName = `durability-test-${Date.now()}`;
    const queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const workerAConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const workerBConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });

    const queue = new Queue(queueName, { connection: queueConnection });
    let firstAttemptStarted = false;
    const processedBy: string[] = [];

    const workerA = new Worker(
      queueName,
      async () => {
        firstAttemptStarted = true;
        // Simulate a crash: never resolve/reject; workerA gets force-closed
        // from outside while this job is still "in flight".
        await new Promise(() => {});
      },
      { connection: workerAConnection, lockDuration: 1000, stalledInterval: 500 },
    );

    try {
      await queue.add('job', { hello: 'world' });

      await vi.waitFor(() => expect(firstAttemptStarted).toBe(true), { timeout: 5000 });
      await workerA.close(true); // force-close: abandons the in-flight job without completing it

      const workerB = new Worker(
        queueName,
        async (job: Job) => {
          processedBy.push('workerB');
          return job.data;
        },
        { connection: workerBConnection, lockDuration: 1000, stalledInterval: 500 },
      );

      try {
        await vi.waitFor(() => expect(processedBy).toContain('workerB'), { timeout: 10000 });
      } finally {
        await workerB.close();
      }
    } finally {
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close().catch(() => {});
      await queueConnection.quit().catch(() => {});
      await workerAConnection.quit().catch(() => {});
      await workerBConnection.quit().catch(() => {});
    }
  }, 20000);
});

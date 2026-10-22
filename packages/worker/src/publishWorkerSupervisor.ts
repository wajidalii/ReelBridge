import type { PlatformType, PublishToTargetJobData } from '@reelbridge/shared';
import {
  activePublishWorkers,
  getDb,
  getLogger,
  publishTargets,
  publishToTargetQueueName,
  startPublishToTargetWorker,
} from '@reelbridge/shared';
import type { Processor, Worker } from 'bullmq';

const DISCOVERY_INTERVAL_MS = Number(process.env.PUBLISH_WORKER_DISCOVERY_INTERVAL_MS ?? 30_000);

interface KnownTarget {
  platform: PlatformType;
  externalId: string;
}

/**
 * The queue topology is one BullMQ queue per (platform, external account) so
 * each account gets its own rate limiter (TDD.md §5 risk 6 / issue #8) — but
 * that means the set of queues isn't known at boot. This supervisor
 * periodically reads the distinct (platform, external_id) pairs from
 * publish_targets and starts a Worker for any pair it hasn't seen, and stops
 * the Worker for any pair that no longer exists (target deleted).
 *
 * Every worker replica runs the same supervisor and so attaches to every
 * queue; BullMQ's limiter is enforced in Redis per queue, not per process, so
 * N replicas still share one account's budget rather than multiplying it.
 */
export function startPublishWorkerSupervisor(processor: Processor<PublishToTargetJobData>) {
  const log = getLogger().child({ component: 'publish-worker-supervisor' });
  const workers = new Map<string, Worker<PublishToTargetJobData>>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  async function reconcile(): Promise<void> {
    const rows = await getDb()
      .selectDistinct({ platform: publishTargets.platform, externalId: publishTargets.externalId })
      // Inactive targets included: they can still hold retries/queued rows
      // that should drain (and fail cleanly) rather than sit forever.
      .from(publishTargets);

    const wanted = new Map<string, KnownTarget>();
    for (const row of rows) {
      wanted.set(publishToTargetQueueName(row.platform, row.externalId), row);
    }

    for (const [queueName, target] of wanted) {
      if (workers.has(queueName)) continue;
      const worker = startPublishToTargetWorker(target.platform, target.externalId, processor);
      worker.on('failed', (job, error) => {
        log.error(
          { queue: queueName, jobId: job?.id, platform: target.platform, err: error },
          'publish job failed',
        );
      });
      worker.on('error', (error) => {
        log.error({ queue: queueName, err: error }, 'publish worker error');
      });
      workers.set(queueName, worker);
      activePublishWorkers.inc({ platform: target.platform });
      log.info({ queue: queueName, platform: target.platform }, 'started publish worker');
    }

    for (const [queueName, worker] of workers) {
      if (wanted.has(queueName)) continue;
      workers.delete(queueName);
      const platform = queueName.split('|')[1] ?? 'unknown';
      activePublishWorkers.dec({ platform });
      await worker.close().catch(() => {});
      log.info({ queue: queueName }, 'stopped publish worker (target removed)');
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      await reconcile();
    } catch (error) {
      log.error({ err: error }, 'publish worker discovery failed');
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), DISCOVERY_INTERVAL_MS);
    }
  }

  void tick();

  return {
    /** Stops discovery; the workers themselves are closed by closeAllQueuesAndWorkers. */
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    /** Test/inspection hook. */
    get activeQueueNames(): string[] {
      return [...workers.keys()];
    },
    reconcile,
  };
}

import './env.js';
import {
  closeAllQueuesAndWorkers,
  closeRedisConnection,
  getLogger,
  getPool,
  startHealthCheckWorker,
  startPollStatusWorker,
  startTopupScheduleWorker,
} from '@reelbridge/shared';
import { startMetricsServer } from './metricsServer.js';
import { processHealthCheck } from './processors/healthCheck.js';
import { processPollStatus } from './processors/pollStatus.js';
import { processPublishToTarget } from './processors/publishToTarget.js';
import { processTopupSchedule } from './processors/topupSchedule.js';
import { startPublishWorkerSupervisor } from './publishWorkerSupervisor.js';

const log = getLogger().child({ component: 'worker' });

for (const name of ['DATABASE_URL', 'REDIS_URL', 'ENCRYPTION_KEY', 'S3_BUCKET']) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

log.info('ReelBridge worker starting');
console.log('ReelBridge worker starting...');

// Shared (non-rate-limited) queues: one worker each.
const pollStatusWorker = startPollStatusWorker(processPollStatus);
const healthCheckWorker = startHealthCheckWorker(processHealthCheck);
const topupWorker = startTopupScheduleWorker(processTopupSchedule);

for (const [name, worker] of Object.entries({
  pollStatus: pollStatusWorker,
  healthCheck: healthCheckWorker,
  topup: topupWorker,
})) {
  worker.on('failed', (job, error) => {
    log.error({ queue: name, jobId: job?.id, err: error }, 'job failed');
  });
  worker.on('error', (error) => {
    log.error({ queue: name, err: error }, 'worker error');
  });
}

// Per-(platform, account) publish queues are discovered from Postgres and
// started/stopped as targets come and go — see publishWorkerSupervisor.ts.
const supervisor = startPublishWorkerSupervisor(processPublishToTarget);

const metricsServer = startMetricsServer();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'worker shutting down — waiting for in-flight jobs');
  supervisor.stop();
  metricsServer.close();
  // Worker.close() waits for the active job to finish (BullMQ then marks it
  // completed) rather than abandoning it to be redelivered as stalled.
  await closeAllQueuesAndWorkers().catch((error: unknown) => {
    log.error({ err: error }, 'error closing queues/workers');
  });
  await closeRedisConnection().catch(() => {});
  await getPool()
    .end()
    .catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'unhandled promise rejection');
});

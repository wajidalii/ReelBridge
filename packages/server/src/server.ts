import './env.js';
import {
  closeAllQueuesAndWorkers,
  closeRedisConnection,
  getLogger,
  getPool,
} from '@reelbridge/shared';
import { createApp } from './app.js';
import { enqueueDueAppManagedPublishJobs } from './cron/appManagedPublishSweep.js';
import { enqueueDueHealthCheckJobs } from './cron/healthCheckSweep.js';
import { runTokenHousekeeping, sampleQueueDepthMetrics } from './cron/housekeepingSweep.js';
import { enqueueDuePollStatusJobs } from './cron/pollStatusSweep.js';
import { enqueueDueScheduleConfigJobs } from './cron/scheduleConfigSweep.js';
import { startScheduleTrigger } from './cron/trigger.js';
import { assertRequiredEnv } from './startupChecks.js';

assertRequiredEnv();

const log = getLogger().child({ component: 'api' });
const port = Number(process.env.PORT ?? 4000);
const app = createApp();

const server = app.listen(port, () => {
  log.info({ port }, 'ReelBridge API listening');
  console.log(`ReelBridge API listening on port ${port}`);
});
// Uploads of several hundred MB over slow links easily exceed Node's default
// socket timeouts; keep-alive is tuned slightly above typical LB idle timeouts.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS ?? 30 * 60 * 1000);

// Cron sweeps only ever *enqueue* — all real work lives in the worker.
// CRON_ENABLED=false lets a horizontally-scaled API tier run the sweeps on
// one designated replica (every sweep is also safe to run on all replicas;
// they claim rows atomically — this is just to avoid wasted ticks).
const tasks =
  process.env.CRON_ENABLED === 'false'
    ? []
    : [
        startScheduleTrigger(enqueueDuePollStatusJobs, '*/5 * * * *', 'poll-status'),
        // Every 20s: Instagram has no platform-side scheduling (TDD.md §1.2), so this
        // sweep *is* the scheduler — publish should start within a tight, documented
        // tolerance of scheduled_at (issue #34 AC), not the 5-minute poll-status
        // cadence, which only exists to confirm an already-platform-held publish.
        startScheduleTrigger(
          enqueueDueAppManagedPublishJobs,
          '*/20 * * * * *',
          'app-managed-publish',
        ),
        // Hourly: token health checks are cheap, read-only, and don't need poll-status's tighter cadence.
        startScheduleTrigger(enqueueDueHealthCheckJobs, '0 * * * *', 'health-check'),
        // Recurring topup schedules (issue #48) are checked every minute.
        startScheduleTrigger(enqueueDueScheduleConfigJobs, '* * * * *', 'schedule-config'),
        startScheduleTrigger(sampleQueueDepthMetrics, '*/1 * * * *', 'metrics-sample'),
        startScheduleTrigger(runTokenHousekeeping, '15 4 * * *', 'token-housekeeping'),
      ];

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  for (const task of tasks) task.stop();
  // Stop accepting new connections, let in-flight requests finish (bounded).
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15_000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  await closeAllQueuesAndWorkers().catch(() => {});
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

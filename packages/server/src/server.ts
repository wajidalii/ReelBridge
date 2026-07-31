import 'dotenv/config';
import { createApp } from './app.js';
import { enqueueDueHealthCheckJobs } from './cron/healthCheckSweep.js';
import { enqueueDuePollStatusJobs } from './cron/pollStatusSweep.js';
import { startScheduleTrigger } from './cron/trigger.js';

const port = Number(process.env.PORT ?? 4000);
const app = createApp();

app.listen(port, () => {
  console.log(`ReelBridge API listening on port ${port}`);
});

startScheduleTrigger(enqueueDuePollStatusJobs);
// Hourly: token health checks are cheap, read-only, and don't need poll-status's tighter cadence.
startScheduleTrigger(enqueueDueHealthCheckJobs, '0 * * * *');

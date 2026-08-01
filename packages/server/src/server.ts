import 'dotenv/config';
import { createApp } from './app.js';
import { enqueueDueAppManagedPublishJobs } from './cron/appManagedPublishSweep.js';
import { enqueueDueHealthCheckJobs } from './cron/healthCheckSweep.js';
import { enqueueDuePollStatusJobs } from './cron/pollStatusSweep.js';
import { startScheduleTrigger } from './cron/trigger.js';

const port = Number(process.env.PORT ?? 4000);
const app = createApp();

app.listen(port, () => {
  console.log(`ReelBridge API listening on port ${port}`);
});

startScheduleTrigger(enqueueDuePollStatusJobs);
// Every 20s: Instagram has no platform-side scheduling (TDD.md §1.2), so this
// sweep *is* the scheduler — publish should start within a tight, documented
// tolerance of scheduled_at (issue #34 AC), not the 5-minute poll-status
// cadence, which only exists to confirm an already-platform-held publish.
startScheduleTrigger(enqueueDueAppManagedPublishJobs, '*/20 * * * * *');
// Hourly: token health checks are cheap, read-only, and don't need poll-status's tighter cadence.
startScheduleTrigger(enqueueDueHealthCheckJobs, '0 * * * *');

import 'dotenv/config';
import { createApp } from './app.js';
import { enqueueDuePollStatusJobs } from './cron/pollStatusSweep.js';
import { startScheduleTrigger } from './cron/trigger.js';

const port = Number(process.env.PORT ?? 4000);
const app = createApp();

app.listen(port, () => {
  console.log(`ReelBridge API listening on port ${port}`);
});

startScheduleTrigger(enqueueDuePollStatusJobs);

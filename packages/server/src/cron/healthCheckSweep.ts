import { enqueueHealthCheck, getDb, publishTargets } from '@reelbridge/shared';
import { eq } from 'drizzle-orm';

/**
 * The "what's due" query for the health-check trigger: every active target
 * on every platform gets a health-check job enqueued, piggybacked on the
 * existing cron tick (design.md §8, issue #36) so a broken token is never
 * discovered only via a failed scheduled post. Inactive targets are skipped
 * — they're already flagged for reconnect, and re-checking a dead token
 * hourly just burns platform rate limit for a known answer; a manual
 * "Revalidate" still re-checks them on demand.
 */
export async function enqueueDueHealthCheckJobs(): Promise<void> {
  const db = getDb();
  const dueRows = await db
    .select({ id: publishTargets.id })
    .from(publishTargets)
    .where(eq(publishTargets.isActive, true));

  await Promise.all(
    dueRows.map((row) => enqueueHealthCheck({ publishTargetId: row.id, trigger: 'sweep' })),
  );
}

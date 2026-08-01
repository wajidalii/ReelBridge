import { enqueueHealthCheck, getDb, publishTargets } from '@reelbridge/shared';
import { and, eq } from 'drizzle-orm';

/**
 * The "what's due" query for the health-check trigger: every active
 * Facebook Page target gets a health-check job enqueued, piggybacked on the
 * existing cron tick (design.md §8) so a broken token is never discovered
 * only via a failed scheduled post.
 */
export async function enqueueDueHealthCheckJobs(): Promise<void> {
  const db = getDb();
  const dueRows = await db
    .select({ id: publishTargets.id })
    .from(publishTargets)
    .where(and(eq(publishTargets.platform, 'facebook_page'), eq(publishTargets.isActive, true)));

  await Promise.all(
    dueRows.map((row) => enqueueHealthCheck({ publishTargetId: row.id, trigger: 'sweep' })),
  );
}

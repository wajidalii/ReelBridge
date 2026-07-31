import { enqueuePollStatus, getDb, postTargets } from '@reelbridge/shared';
import { eq } from 'drizzle-orm';

/**
 * The "what's due" query for the poll-status trigger: every post_targets row
 * still native_scheduled (platform holds the future publish, we're only
 * confirming it happened) gets a poll job enqueued. Enqueue-only, per the
 * architecture — the actual Graph API check and DB write happen in the
 * worker's processPollStatus.
 */
export async function enqueueDuePollStatusJobs(): Promise<void> {
  const db = getDb();
  const dueRows = await db
    .select({ id: postTargets.id })
    .from(postTargets)
    .where(eq(postTargets.status, 'native_scheduled'));

  await Promise.all(dueRows.map((row) => enqueuePollStatus({ postTargetId: row.id })));
}

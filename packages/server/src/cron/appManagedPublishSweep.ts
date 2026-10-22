import {
  appManagedLateTotal,
  enqueuePublishToTarget,
  getDb,
  getLogger,
  postTargets,
  publishTargets,
} from '@reelbridge/shared';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';

// How late an awaiting_app_managed_publish row can be found past its
// scheduled_at before this sweep treats it as an alertable event rather than
// routine jitter (a normal tick landing a few seconds after scheduled_at
// isn't an incident; a sweep that didn't run for N minutes — e.g. the API
// process was down — is). Configurable per PROJECT.md's observability NFR.
// Read lazily (not hoisted to a module-load-time constant) so tests can
// override it per-case via process.env without reimporting the module.
function getLateThresholdMs(): number {
  return Number(process.env.APP_MANAGED_PUBLISH_LATE_THRESHOLD_MINUTES ?? 5) * 60_000;
}

/**
 * The "what's due" query for Instagram's app-managed scheduling (TDD.md
 * §1.2/§5 risk 1, issue #34): every post_targets row still
 * `awaiting_app_managed_publish` whose scheduled_at has arrived gets the real
 * publish job enqueued now, not before — Instagram has no platform-side
 * scheduling, so this sweep *is* the scheduler. Deliberately DB-state-driven
 * (like the poll-status/health-check sweeps) rather than a single BullMQ
 * delayed job scheduled far in advance: a worker/API restart just re-derives
 * "what's due" from Postgres on the next tick instead of losing anything
 * in-memory, so redelivery/durability falls out of the design rather than
 * needing separate handling.
 *
 * Due rows are *claimed* with a single UPDATE … RETURNING (status flipped to
 * 'queued' before the enqueue) so two API replicas ticking at the same
 * moment can't both pick up the same row. If the enqueue then fails the row
 * is put back to awaiting_app_managed_publish for the next tick.
 *
 * Rows found more than the configured threshold past their scheduled_at are
 * logged and counted as a distinct, observable alert event before being
 * enqueued same as any other due row — still published, just flagged as
 * late (design.md/PROJECT.md: "resilient" for Instagram means "recovers and
 * publishes late," not "never late").
 */
export async function enqueueDueAppManagedPublishJobs(): Promise<void> {
  const db = getDb();
  const now = new Date();
  const log = getLogger();

  const claimed = await db
    .update(postTargets)
    .set({ status: 'queued', updatedAt: now })
    .where(
      and(
        eq(postTargets.status, 'awaiting_app_managed_publish'),
        lte(postTargets.scheduledAt, now),
      ),
    )
    .returning({
      id: postTargets.id,
      scheduledAt: postTargets.scheduledAt,
      publishTargetId: postTargets.publishTargetId,
    });
  if (claimed.length === 0) return;

  const targetIds = [...new Set(claimed.map((row) => row.publishTargetId))];
  const targets = await db
    .select({
      id: publishTargets.id,
      platform: publishTargets.platform,
      externalId: publishTargets.externalId,
    })
    .from(publishTargets)
    .where(inArray(publishTargets.id, targetIds));
  const targetById = new Map(targets.map((target) => [target.id, target]));

  await Promise.all(
    claimed.map(async (row) => {
      const target = targetById.get(row.publishTargetId);
      if (!target) return;

      const lateMs = row.scheduledAt ? now.getTime() - row.scheduledAt.getTime() : 0;
      if (lateMs > getLateThresholdMs()) {
        appManagedLateTotal.inc({ platform: target.platform });
        // Kept on console.error too: this is the alert hook from #34 that
        // existing log-based alerting (and the integration test) matches on.
        console.error('[app-managed-publish-late]', {
          postTargetId: row.id,
          scheduledAt: row.scheduledAt?.toISOString(),
          lateMinutes: Math.round(lateMs / 60_000),
        });
      }

      try {
        await enqueuePublishToTarget(target.platform, target.externalId, { postTargetId: row.id });
      } catch (error) {
        log.error(
          { err: error, postTargetId: row.id },
          'failed to enqueue due app-managed publish',
        );
        await db
          .update(postTargets)
          .set({ status: 'awaiting_app_managed_publish', updatedAt: sql`now()` })
          .where(and(eq(postTargets.id, row.id), eq(postTargets.status, 'queued')));
      }
    }),
  );
}

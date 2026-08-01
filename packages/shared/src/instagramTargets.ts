import { and, eq } from 'drizzle-orm';
import { getDb, type Database } from './db/client.js';
import { publishTargets } from './db/schema.js';

export interface InstagramAccountSummary {
  id: string;
  username?: string;
}

// Kept structurally identical to @reelbridge/platform-facebook's
// InstagramDiscoveryResult (this package can't depend on that one, so it's
// duplicated rather than imported) — see the comment there for the other
// half of this pairing.
export type InstagramDiscoveryOutcome =
  | { status: 'linked'; account: InstagramAccountSummary }
  | { status: 'not_linked' }
  | { status: 'personal_account'; accountId: string };

export interface ReconcileInstagramTargetParams {
  userId: string;
  platformConnectionId: string;
  facebookPageId: string;
  discovery: InstagramDiscoveryOutcome;
}

/**
 * Deactivates any active instagram_business row this user previously had
 * linked to this Facebook Page, other than (optionally) the one that's still
 * current. Scans the user's active IG targets in JS rather than a jsonb query
 * against metadata.linkedFacebookPageId — that set is always small (one row
 * per connected Page), so this stays simple rather than introducing a query
 * pattern not used anywhere else in the codebase.
 */
async function deactivateStaleTargetsForPage(
  db: Database,
  userId: string,
  facebookPageId: string,
  keepExternalId: string | null,
): Promise<void> {
  const activeIgTargets = await db
    .select()
    .from(publishTargets)
    .where(
      and(
        eq(publishTargets.userId, userId),
        eq(publishTargets.platform, 'instagram_business'),
        eq(publishTargets.isActive, true),
      ),
    );

  const stale = activeIgTargets.filter(
    (row) =>
      (row.metadata as { linkedFacebookPageId?: string } | null)?.linkedFacebookPageId ===
        facebookPageId && row.externalId !== keepExternalId,
  );

  for (const row of stale) {
    await db
      .update(publishTargets)
      .set({ isActive: false, lastValidatedAt: new Date() })
      .where(eq(publishTargets.id, row.id));
  }
}

/**
 * Single write path for the instagram_business row tied to one Facebook Page,
 * shared by the initial connect flow (issue #11) and the health-check
 * re-check (issue #15) so a Page whose linked IG account changes — newly
 * linked, unlinked entirely, replaced by a different account, or downgraded
 * to Personal — converges to the same state either way, rather than only
 * ever being discovered once at connect time.
 */
export async function reconcileInstagramTarget(
  params: ReconcileInstagramTargetParams,
): Promise<InstagramAccountSummary | null> {
  const { userId, platformConnectionId, facebookPageId, discovery } = params;
  const db = getDb();

  if (discovery.status === 'linked') {
    const displayName = discovery.account.username ?? discovery.account.id;
    await db
      .insert(publishTargets)
      .values({
        userId,
        platformConnectionId,
        platform: 'instagram_business',
        externalId: discovery.account.id,
        displayName,
        tokenSource: 'oauth',
        metadata: { linkedFacebookPageId: facebookPageId, username: discovery.account.username },
        lastValidatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [publishTargets.userId, publishTargets.platform, publishTargets.externalId],
        set: {
          displayName,
          isActive: true,
          lastValidatedAt: new Date(),
          metadata: { linkedFacebookPageId: facebookPageId, username: discovery.account.username },
        },
      });
    // Covers the case where the Page's linked IG account was swapped for a
    // different one: the old account's row must not be left active.
    await deactivateStaleTargetsForPage(db, userId, facebookPageId, discovery.account.id);
    return discovery.account;
  }

  if (discovery.status === 'personal_account') {
    // The account was previously Business/Creator (and so may already have a
    // publish_targets row from an earlier connect/re-check) but has since
    // been downgraded to Personal — retract it rather than leaving a stale
    // "connectable" target around.
    await db
      .update(publishTargets)
      .set({ isActive: false, lastValidatedAt: new Date() })
      .where(
        and(
          eq(publishTargets.userId, userId),
          eq(publishTargets.platform, 'instagram_business'),
          eq(publishTargets.externalId, discovery.accountId),
        ),
      );
    return null;
  }

  // not_linked: the Page may have had an IG account linked previously (at an
  // earlier connect or re-check) that's since been fully unlinked — retract
  // it rather than leaving a target Meta will now reject on publish.
  await deactivateStaleTargetsForPage(db, userId, facebookPageId, null);
  return null;
}

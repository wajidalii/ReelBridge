import { getDb, platformConnections, publishTargets } from '@reelbridge/shared';
import { and, count, eq } from 'drizzle-orm';
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';

export const connectionsRouter = Router();

/** The user's OAuth-level connections (one per provider), with how many targets hang off each. */
connectionsRouter.get('/', requireAuth, async (req, res) => {
  const db = getDb();
  const rows = await db
    .select({
      id: platformConnections.id,
      platform: platformConnections.platform,
      displayName: platformConnections.displayName,
      externalAccountId: platformConnections.externalAccountId,
      status: platformConnections.status,
      scopes: platformConnections.scopes,
      tokenExpiresAt: platformConnections.tokenExpiresAt,
      createdAt: platformConnections.createdAt,
      updatedAt: platformConnections.updatedAt,
      targetCount: count(publishTargets.id),
    })
    .from(platformConnections)
    .leftJoin(
      publishTargets,
      and(
        eq(publishTargets.platformConnectionId, platformConnections.id),
        eq(publishTargets.isActive, true),
      ),
    )
    .where(eq(platformConnections.userId, req.userId!))
    .groupBy(platformConnections.id);

  res.json(
    rows.map((row) => ({
      ...row,
      targetCount: Number(row.targetCount),
      hasRefreshToken: undefined,
    })),
  );
});

/**
 * Disconnecting a provider cascades to every publish target under it (and
 * their post_targets rows) — the schema's ON DELETE CASCADE does the work.
 * Scoped by user_id in the WHERE so another tenant's id is a 404, never a
 * delete (same reasoning as assertOwnership: no 403 that confirms existence).
 */
connectionsRouter.delete('/:id', requireAuth, async (req, res) => {
  const id = req.params.id as string;
  const deleted = await getDb()
    .delete(platformConnections)
    .where(and(eq(platformConnections.id, id), eq(platformConnections.userId, req.userId!)))
    .returning({ id: platformConnections.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  res.status(204).send();
});

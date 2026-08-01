import { enqueueHealthCheck, getDb, PLATFORM_CAPABILITIES, publishTargets } from '@reelbridge/shared';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { assertTargetOwnership } from '../ownership/assertOwnership.js';
import { requireOwnership } from '../ownership/middleware.js';

export const targetsRouter = Router();

// Lets the target-assignment UI (#24) render a multi-select of the user's
// connected targets, with each platform's scheduling/caption capabilities
// merged in so the client can show the "app-managed scheduling" note and
// caption/title fields without duplicating that knowledge.
targetsRouter.get('/', requireAuth, async (req, res) => {
  const targets = await getDb()
    .select()
    .from(publishTargets)
    .where(eq(publishTargets.userId, req.userId!));

  res.json(
    targets.map((target) => ({
      id: target.id,
      platform: target.platform,
      externalId: target.externalId,
      displayName: target.displayName,
      avatarUrl: target.avatarUrl,
      timezone: target.timezone,
      isActive: target.isActive,
      capabilities: PLATFORM_CAPABILITIES[target.platform],
    })),
  );
});

/**
 * Enqueue-only, per the architecture: the actual Graph API check and
 * is_active/last_validated_at write happen in the worker's processHealthCheck.
 * "Immediate" means high-priority queued, not synchronous — same "Run now"
 * pattern as the rest of the scheduling system.
 */
targetsRouter.post(
  '/:id/revalidate',
  requireAuth,
  requireOwnership('id', assertTargetOwnership),
  async (req, res) => {
    // requireOwnership already validated req.params.id is a single non-array string.
    await enqueueHealthCheck({ publishTargetId: req.params.id as string, trigger: 'manual' });
    res.status(202).json({ queued: true });
  },
);

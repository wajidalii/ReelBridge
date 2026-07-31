import { enqueueHealthCheck } from '@reelbridge/shared';
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { assertTargetOwnership } from '../ownership/assertOwnership.js';
import { requireOwnership } from '../ownership/middleware.js';

export const targetsRouter = Router();

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
    await enqueueHealthCheck({ publishTargetId: req.params.id as string });
    res.status(202).json({ queued: true });
  },
);

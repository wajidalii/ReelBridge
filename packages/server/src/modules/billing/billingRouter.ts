import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { getUsageSnapshot } from './checkUsageLimit.js';

export const billingRouter = Router();

/** Lets the client show "X of Y targets used" and an upgrade prompt once limits are enforced. */
billingRouter.get('/usage', requireAuth, async (req, res) => {
  const usage = await getUsageSnapshot(req.userId!);
  res.json({
    plan: {
      name: usage.plan.name,
      maxTargets: usage.plan.maxTargets,
      maxPostsPerMonth: usage.plan.maxPostsPerMonth,
      subscriptionStatus: usage.plan.subscriptionStatus,
    },
    activeTargets: usage.activeTargets,
    postsThisMonth: usage.postsThisMonth,
    enforced: usage.enforced,
  });
});

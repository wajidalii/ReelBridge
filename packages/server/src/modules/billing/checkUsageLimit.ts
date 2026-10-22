import {
  getDb,
  plans,
  postBatches,
  postItems,
  postTargets,
  publishTargets,
  subscriptions,
} from '@reelbridge/shared';
import { and, count, eq, gte } from 'drizzle-orm';

export type UsageAction = 'connect_target' | 'publish_post';

/** Maps to a 402 with an actionable message (issue #43 AC: never a bare 403). */
export class UsageLimitError extends Error {
  readonly action: UsageAction;
  readonly limit: number;
  readonly current: number;

  constructor(action: UsageAction, limit: number, current: number, message: string) {
    super(message);
    this.name = 'UsageLimitError';
    this.action = action;
    this.limit = limit;
    this.current = current;
  }
}

/** Plan limits are only enforced when explicitly switched on — the schema and call sites exist so wiring Stripe (#43) is a config flip plus a webhook, not a route refactor. */
export function planLimitsEnforced(): boolean {
  return process.env.PLAN_LIMITS_ENFORCED === 'true';
}

export interface EffectivePlan {
  planId: string | null;
  name: string;
  maxTargets: number;
  maxPostsPerMonth: number;
  subscriptionStatus: string | null;
}

export async function getEffectivePlan(userId: string): Promise<EffectivePlan> {
  const db = getDb();
  const [row] = await db
    .select({ plan: plans, subscription: subscriptions })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  if (row) {
    return {
      planId: row.plan.id,
      name: row.plan.name,
      maxTargets: row.plan.maxTargets,
      maxPostsPerMonth: row.plan.maxPostsPerMonth,
      subscriptionStatus: row.subscription.status,
    };
  }
  const [defaultPlan] = await db.select().from(plans).where(eq(plans.isDefault, true)).limit(1);
  if (defaultPlan) {
    return {
      planId: defaultPlan.id,
      name: defaultPlan.name,
      maxTargets: defaultPlan.maxTargets,
      maxPostsPerMonth: defaultPlan.maxPostsPerMonth,
      subscriptionStatus: null,
    };
  }
  // No plans seeded at all: unlimited, same as the pre-billing behaviour.
  return {
    planId: null,
    name: 'Unlimited',
    maxTargets: Number.MAX_SAFE_INTEGER,
    maxPostsPerMonth: Number.MAX_SAFE_INTEGER,
    subscriptionStatus: null,
  };
}

/** Attaches the default plan to a new user so `subscriptions` is the single place a Stripe webhook later needs to update. */
export async function ensureDefaultSubscription(userId: string): Promise<void> {
  const db = getDb();
  const [defaultPlan] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.isDefault, true))
    .limit(1);
  if (!defaultPlan) return;
  await db
    .insert(subscriptions)
    .values({ userId, planId: defaultPlan.id, status: 'active' })
    .onConflictDoNothing({ target: subscriptions.userId });
}

export interface UsageSnapshot {
  plan: EffectivePlan;
  activeTargets: number;
  postsThisMonth: number;
  enforced: boolean;
}

export async function getUsageSnapshot(userId: string): Promise<UsageSnapshot> {
  const db = getDb();
  const plan = await getEffectivePlan(userId);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [[targetsRow], [postsRow]] = await Promise.all([
    db
      .select({ value: count() })
      .from(publishTargets)
      .where(and(eq(publishTargets.userId, userId), eq(publishTargets.isActive, true))),
    db
      .select({ value: count() })
      .from(postTargets)
      .innerJoin(postItems, eq(postTargets.postItemId, postItems.id))
      .innerJoin(postBatches, eq(postItems.batchId, postBatches.id))
      .where(and(eq(postBatches.userId, userId), gte(postTargets.createdAt, monthStart))),
  ]);

  return {
    plan,
    activeTargets: Number(targetsRow?.value ?? 0),
    postsThisMonth: Number(postsRow?.value ?? 0),
    enforced: planLimitsEnforced(),
  };
}

/**
 * The single enforcement point called before connecting a target or
 * assigning a post to one. `additional` is how many new targets/posts the
 * current request would add (a batch assignment can add several at once).
 */
export async function checkUsageLimit(
  userId: string,
  action: UsageAction,
  additional = 1,
): Promise<void> {
  if (!planLimitsEnforced()) return;
  const usage = await getUsageSnapshot(userId);

  if (action === 'connect_target' && usage.activeTargets + additional > usage.plan.maxTargets) {
    throw new UsageLimitError(
      action,
      usage.plan.maxTargets,
      usage.activeTargets,
      `Your ${usage.plan.name} plan allows ${usage.plan.maxTargets} connected target${usage.plan.maxTargets === 1 ? '' : 's'}. Disconnect one or upgrade your plan to connect more.`,
    );
  }
  if (
    action === 'publish_post' &&
    usage.postsThisMonth + additional > usage.plan.maxPostsPerMonth
  ) {
    throw new UsageLimitError(
      action,
      usage.plan.maxPostsPerMonth,
      usage.postsThisMonth,
      `Your ${usage.plan.name} plan allows ${usage.plan.maxPostsPerMonth} posts per month and you've used ${usage.postsThisMonth}. Upgrade your plan to schedule more this month.`,
    );
  }
}

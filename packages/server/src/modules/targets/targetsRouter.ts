import {
  enqueueHealthCheck,
  enqueueTopupSchedule,
  getDb,
  PLATFORM_CAPABILITIES,
  platformConnections,
  publishTargets,
  scheduleConfigs,
  scheduleRuns,
} from '@reelbridge/shared';
import { and, desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { assertTargetOwnership } from '../ownership/assertOwnership.js';
import { requireOwnership } from '../ownership/middleware.js';
import { isValidTimezone } from './timezone.js';

export const targetsRouter = Router();

type TargetRow = typeof publishTargets.$inferSelect;
type ConnectionRow = typeof platformConnections.$inferSelect;

export type TargetHealth = 'healthy' | 'needs_reconnect' | 'revoked' | 'unchecked';

/**
 * Plain-language health state for the settings view (issue #36), derived
 * from the target's own is_active flag plus the owning connection's status
 * — a YouTube channel's health is really the Google refresh token's health.
 */
export function deriveTargetHealth(
  target: TargetRow,
  connection: ConnectionRow | null,
): TargetHealth {
  if (connection && connection.status === 'revoked') return 'revoked';
  if (!target.isActive) return 'needs_reconnect';
  if (connection && connection.status === 'expired') return 'needs_reconnect';
  if (!target.lastValidatedAt) return 'unchecked';
  return 'healthy';
}

function serializeTarget(target: TargetRow, connection: ConnectionRow | null) {
  const metadata = (target.metadata ?? {}) as Record<string, unknown>;
  return {
    id: target.id,
    platform: target.platform,
    externalId: target.externalId,
    displayName: target.displayName,
    avatarUrl: target.avatarUrl,
    timezone: target.timezone,
    isActive: target.isActive,
    tokenSource: target.tokenSource,
    connectedAt: target.connectedAt,
    lastValidatedAt: target.lastValidatedAt,
    health: deriveTargetHealth(target, connection),
    connectionId: target.platformConnectionId,
    connectionStatus: connection?.status ?? null,
    username: typeof metadata.username === 'string' ? metadata.username : null,
    linkedFacebookPageId:
      typeof metadata.linkedFacebookPageId === 'string' ? metadata.linkedFacebookPageId : null,
    lastHealthError: typeof metadata.lastHealthError === 'string' ? metadata.lastHealthError : null,
    capabilities: PLATFORM_CAPABILITIES[target.platform],
  };
}

// Lets the target-assignment UI (#24) render a multi-select of the user's
// connected targets, with each platform's scheduling/caption capabilities
// merged in so the client can show the "app-managed scheduling" note and
// caption/title fields without duplicating that knowledge. Also backs the
// settings/health page (#36).
targetsRouter.get('/', requireAuth, async (req, res) => {
  const rows = await getDb()
    .select({ target: publishTargets, connection: platformConnections })
    .from(publishTargets)
    .leftJoin(platformConnections, eq(publishTargets.platformConnectionId, platformConnections.id))
    .where(eq(publishTargets.userId, req.userId!))
    .orderBy(publishTargets.platform, publishTargets.displayName);

  res.json(rows.map((row) => serializeTarget(row.target, row.connection)));
});

targetsRouter.get(
  '/:id',
  requireAuth,
  requireOwnership('id', assertTargetOwnership),
  async (req, res) => {
    const [row] = await getDb()
      .select({ target: publishTargets, connection: platformConnections })
      .from(publishTargets)
      .leftJoin(
        platformConnections,
        eq(publishTargets.platformConnectionId, platformConnections.id),
      )
      .where(eq(publishTargets.id, req.params.id as string));
    if (!row) {
      res.status(404).json({ error: 'Target not found' });
      return;
    }
    res.json(serializeTarget(row.target, row.connection));
  },
);

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
    await enqueueHealthCheck({ publishTargetId: req.params.id as string, trigger: 'manual' });
    res.status(202).json({ queued: true });
  },
);

/** Removes one target (its post_targets cascade). The owning connection stays — other targets may use it. */
targetsRouter.delete(
  '/:id',
  requireAuth,
  requireOwnership('id', assertTargetOwnership),
  async (req, res) => {
    await getDb()
      .delete(publishTargets)
      .where(eq(publishTargets.id, req.params.id as string));
    res.status(204).send();
  },
);

// --- recurring "evergreen topup" schedule (issue #48) -----------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Instagram's app-managed scheduling gets a deliberately tighter window
 * than Facebook/YouTube's platform-held scheduling (TDD.md §5 risk 1/10): a
 * post sitting in our queue for weeks has weeks of exposure to our own
 * outages, whereas a natively-scheduled one is the platform's problem once
 * accepted.
 */
export function maxScheduleDaysFor(platform: TargetRow['platform']): number {
  if (platform === 'instagram_business') return 7;
  const cap = PLATFORM_CAPABILITIES[platform].maxScheduleLeadDays;
  return cap === null ? 90 : Math.min(cap, 90);
}

const scheduleConfigSchema = z.object({
  daily_slots: z.array(z.string().regex(HHMM)).min(1).max(24),
  timezone: z.string().min(1).max(64).refine(isValidTimezone, 'Invalid IANA timezone'),
  max_schedule_days: z.number().int().min(1).max(90).optional(),
  min_lead_minutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .optional(),
  /** How often the topup runs; one of a fixed set so the cron stays predictable. */
  cadence: z.enum(['hourly', 'every_6_hours', 'daily', 'weekly']).default('daily'),
  is_enabled: z.boolean().default(true),
});

const CADENCE_TO_CRON: Record<z.infer<typeof scheduleConfigSchema>['cadence'], string> = {
  hourly: '0 * * * *',
  every_6_hours: '0 */6 * * *',
  daily: '0 3 * * *',
  weekly: '0 3 * * 1',
};
const CADENCE_TO_INTERVAL_MS: Record<z.infer<typeof scheduleConfigSchema>['cadence'], number> = {
  hourly: 60 * 60 * 1000,
  every_6_hours: 6 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export function cadenceFromCron(cron: string): keyof typeof CADENCE_TO_CRON {
  const found = (Object.keys(CADENCE_TO_CRON) as Array<keyof typeof CADENCE_TO_CRON>).find(
    (key) => CADENCE_TO_CRON[key] === cron,
  );
  return found ?? 'daily';
}

/** Advances next_run_at by one cadence interval from `from` (used by both the PUT here and the cron sweep). */
export function computeNextRunAt(cronExpression: string, from = new Date()): Date {
  return new Date(from.getTime() + CADENCE_TO_INTERVAL_MS[cadenceFromCron(cronExpression)]);
}

function serializeConfig(
  config: typeof scheduleConfigs.$inferSelect,
  platform: TargetRow['platform'],
) {
  return {
    publishTargetId: config.publishTargetId,
    dailySlots: config.dailySlots as string[],
    timezone: config.timezone,
    maxScheduleDays: config.maxScheduleDays,
    minLeadMinutes: config.minLeadMinutes,
    cadence: cadenceFromCron(config.cronExpression),
    nextRunAt: config.nextRunAt,
    lastRunAt: config.lastRunAt,
    isEnabled: config.isEnabled,
    platformMaxScheduleDays: maxScheduleDaysFor(platform),
  };
}

targetsRouter.get(
  '/:id/schedule/config',
  requireAuth,
  requireOwnership('id', assertTargetOwnership),
  async (req, res) => {
    const targetId = req.params.id as string;
    const db = getDb();
    const [target] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
    if (!target) {
      res.status(404).json({ error: 'Target not found' });
      return;
    }
    const [config] = await db
      .select()
      .from(scheduleConfigs)
      .where(eq(scheduleConfigs.publishTargetId, targetId));
    const runs = await db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.publishTargetId, targetId))
      .orderBy(desc(scheduleRuns.startedAt))
      .limit(10);
    res.json({
      config: config ? serializeConfig(config, target.platform) : null,
      platformMaxScheduleDays: maxScheduleDaysFor(target.platform),
      recentRuns: runs,
    });
  },
);

targetsRouter.put(
  '/:id/schedule/config',
  requireAuth,
  requireOwnership('id', assertTargetOwnership),
  async (req, res) => {
    const parsed = scheduleConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'daily_slots (HH:mm[]), timezone (IANA), and an optional cadence are required',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const targetId = req.params.id as string;
    const db = getDb();
    const [target] = await db.select().from(publishTargets).where(eq(publishTargets.id, targetId));
    if (!target) {
      res.status(404).json({ error: 'Target not found' });
      return;
    }

    const platformCap = maxScheduleDaysFor(target.platform);
    const maxScheduleDays = Math.min(parsed.data.max_schedule_days ?? platformCap, platformCap);
    const minLeadMinutes =
      parsed.data.min_lead_minutes ??
      Math.max(PLATFORM_CAPABILITIES[target.platform].minScheduleLeadMinutes ?? 0, 15);
    const cronExpression = CADENCE_TO_CRON[parsed.data.cadence];
    const dailySlots = [...new Set(parsed.data.daily_slots)].sort();

    const values = {
      publishTargetId: targetId,
      dailySlots,
      timezone: parsed.data.timezone,
      maxScheduleDays,
      minLeadMinutes,
      cronExpression,
      isEnabled: parsed.data.is_enabled,
      // First run as soon as the sweep next ticks — a user enabling a cadence
      // expects their backlog to start being scheduled now, not tomorrow.
      nextRunAt: parsed.data.is_enabled ? new Date() : null,
    };
    const [config] = await db
      .insert(scheduleConfigs)
      .values(values)
      .onConflictDoUpdate({ target: scheduleConfigs.publishTargetId, set: values })
      .returning();
    res.json(serializeConfig(config!, target.platform));
  },
);

/** "Run now": the same enqueue path the cron sweep uses, just triggered by a click. */
targetsRouter.post(
  '/:id/schedule/trigger',
  requireAuth,
  requireOwnership('id', assertTargetOwnership),
  async (req, res) => {
    const targetId = req.params.id as string;
    const [config] = await getDb()
      .select({ id: scheduleConfigs.id })
      .from(scheduleConfigs)
      .where(and(eq(scheduleConfigs.publishTargetId, targetId)));
    if (!config) {
      res.status(400).json({ error: 'Set up a schedule for this target before running it.' });
      return;
    }
    await enqueueTopupSchedule({ publishTargetId: targetId, triggeredBy: 'manual' });
    res.status(202).json({ queued: true });
  },
);

import 'dotenv/config';
import {
  encrypt,
  getDb,
  getPool,
  getQueue,
  mediaAssets,
  platformConnections,
  postBatches,
  postItems,
  postTargets,
  publishTargets,
  publishToTargetQueueName,
  scheduleConfigs,
  scheduleRuns,
  users,
  type TopupScheduleJobData,
} from '@reelbridge/shared';
import type { Job } from 'bullmq';
import { eq, inArray, like } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { processTopupSchedule } from './topupSchedule.js';

process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';
const TEST_EMAIL_PREFIX = 'reelbridge-topup-test+';

async function isDatabaseReachable(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
async function isRedisReachable(): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) return false;
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}
const ready = (await Promise.all([isDatabaseReachable(), isRedisReachable()])).every(Boolean);

async function seed(platform: 'instagram_business' | 'youtube_channel', backlogSize: number) {
  const db = getDb();
  const email = `${TEST_EMAIL_PREFIX}${platform}-${Date.now()}@example.com`;
  const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
  const [conn] = await db
    .insert(platformConnections)
    .values({
      userId: user!.id,
      platform: platform === 'youtube_channel' ? 'google' : 'facebook',
      externalAccountId: 'me',
      displayName: 'conn',
      accessTokenCiphertext: 'x',
      accessTokenIv: 'x',
      accessTokenTag: 'x',
    })
    .returning();
  const tok = encrypt('t');
  const [target] = await db
    .insert(publishTargets)
    .values({
      userId: user!.id,
      platformConnectionId: conn!.id,
      platform,
      externalId: `ext-${email}`,
      displayName: 'target',
      accessTokenCiphertext: tok.ciphertext,
      accessTokenIv: tok.iv,
      accessTokenTag: tok.tag,
    })
    .returning();
  await db.insert(scheduleConfigs).values({
    publishTargetId: target!.id,
    dailySlots: ['09:00', '18:00'],
    timezone: 'UTC',
    maxScheduleDays: 2,
    minLeadMinutes: 0,
    cronExpression: '0 3 * * *',
    nextRunAt: new Date(),
  });
  const [batch] = await db.insert(postBatches).values({ userId: user!.id, name: 'b' }).returning();
  const [media] = await db
    .insert(mediaAssets)
    .values({ userId: user!.id, originalFilename: 'a.mp4', storageKey: 'k', fileSizeBytes: 1 })
    .returning();
  const rows: string[] = [];
  for (let i = 0; i < backlogSize; i++) {
    const [item] = await db
      .insert(postItems)
      .values({ batchId: batch!.id, mediaAssetId: media!.id, defaultCaption: `c${i}` })
      .returning();
    const [pt] = await db
      .insert(postTargets)
      .values({ postItemId: item!.id, publishTargetId: target!.id, status: 'pending' })
      .returning();
    rows.push(pt!.id);
  }
  return { user: user!, target: target!, rows };
}

describe.skipIf(!ready)('processTopupSchedule (issue #48)', () => {
  afterAll(async () => {
    const db = getDb();
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
    const ids = testUsers.map((u) => u.id);
    if (ids.length > 0) {
      const batches = await db
        .select({ id: postBatches.id })
        .from(postBatches)
        .where(inArray(postBatches.userId, ids));
      const batchIds = batches.map((b) => b.id);
      if (batchIds.length > 0) {
        const items = await db
          .select({ id: postItems.id })
          .from(postItems)
          .where(inArray(postItems.batchId, batchIds));
        const itemIds = items.map((i) => i.id);
        if (itemIds.length > 0)
          await db.delete(postTargets).where(inArray(postTargets.postItemId, itemIds));
        await db.delete(postItems).where(inArray(postItems.id, itemIds));
        await db.delete(postBatches).where(inArray(postBatches.id, batchIds));
      }
      await db.delete(mediaAssets).where(inArray(mediaAssets.userId, ids));
      await db.delete(publishTargets).where(inArray(publishTargets.userId, ids));
      await db.delete(platformConnections).where(inArray(platformConnections.userId, ids));
      await db.delete(users).where(inArray(users.id, ids));
    }
    await getPool().end();
  });

  it('dates an Instagram backlog into awaiting_app_managed_publish (no publish job yet), leaving overflow pending', async () => {
    // 2 slots/day × 2-day window = at most 4-6 slots; backlog of 8 leaves leftovers.
    const { target, rows } = await seed('instagram_business', 8);
    const job = {
      id: 'j',
      data: { publishTargetId: target.id, triggeredBy: 'manual' },
    } as Job<TopupScheduleJobData>;
    await processTopupSchedule(job);

    const db = getDb();
    const updated = await db.select().from(postTargets).where(inArray(postTargets.id, rows));
    const dated = updated.filter((r) => r.status === 'awaiting_app_managed_publish');
    const leftover = updated.filter((r) => r.status === 'pending' && r.scheduledAt === null);
    expect(dated.length).toBeGreaterThan(0);
    expect(dated.length + leftover.length).toBe(8);
    expect(leftover.length).toBeGreaterThan(0);
    // Distinct slots, all in the future.
    const times = new Set(dated.map((r) => r.scheduledAt!.getTime()));
    expect(times.size).toBe(dated.length);
    for (const t of times) expect(t).toBeGreaterThan(Date.now());

    const [run] = await db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.publishTargetId, target.id));
    expect(run).toMatchObject({
      status: 'completed',
      itemsConsidered: 8,
      itemsScheduled: dated.length,
      itemsLeftover: leftover.length,
      triggeredBy: 'manual',
    });

    // A second run doesn't double-book slots already taken.
    await processTopupSchedule(job);
    const after = await db.select().from(postTargets).where(inArray(postTargets.id, rows));
    const allTimes = after.filter((r) => r.scheduledAt).map((r) => r.scheduledAt!.getTime());
    expect(new Set(allTimes).size).toBe(allTimes.length);
  });

  it('queues YouTube (native scheduling) rows immediately with a publish job per row', async () => {
    const { target, rows } = await seed('youtube_channel', 2);
    const job = {
      id: 'j2',
      data: { publishTargetId: target.id, triggeredBy: 'cron' },
    } as Job<TopupScheduleJobData>;
    await processTopupSchedule(job);

    const updated = await getDb().select().from(postTargets).where(inArray(postTargets.id, rows));
    expect(updated.every((r) => r.status === 'queued' && r.scheduledAt !== null)).toBe(true);

    const queue = getQueue<{ postTargetId: string }>(
      publishToTargetQueueName('youtube_channel', target.externalId),
    );
    for (const id of rows) {
      const j = await queue.getJob(id);
      expect(j).toBeTruthy();
      await j?.remove();
    }
  });
});

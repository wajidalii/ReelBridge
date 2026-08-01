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
  publishToTargetQueueName,
  publishTargets,
  users,
} from '@reelbridge/shared';
import { eq, inArray, like } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueDueAppManagedPublishJobs } from './appManagedPublishSweep.js';

process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';

const TEST_EMAIL_PREFIX = 'reelbridge-app-managed-sweep-test+';

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

const [dbReachable, redisReachable] = await Promise.all([
  isDatabaseReachable(),
  isRedisReachable(),
]);
const ready = dbReachable && redisReachable;

async function createPostTarget(
  email: string,
  scheduledAt: Date | null,
  status: 'awaiting_app_managed_publish' | 'published' | 'pending',
) {
  const db = getDb();
  const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
  if (!user) throw new Error('failed to insert test user');

  const [connection] = await db
    .insert(platformConnections)
    .values({
      userId: user.id,
      platform: 'facebook',
      externalAccountId: 'me',
      displayName: 'Facebook',
      accessTokenCiphertext: 'x',
      accessTokenIv: 'x',
      accessTokenTag: 'x',
    })
    .returning();
  if (!connection) throw new Error('failed to insert test connection');

  const encryptedToken = encrypt('token');
  const [target] = await db
    .insert(publishTargets)
    .values({
      userId: user.id,
      platformConnectionId: connection.id,
      platform: 'instagram_business',
      externalId: `ig-${email}`,
      displayName: 'Sweep Test IG Account',
      accessTokenCiphertext: encryptedToken.ciphertext,
      accessTokenIv: encryptedToken.iv,
      accessTokenTag: encryptedToken.tag,
    })
    .returning();
  if (!target) throw new Error('failed to insert test target');

  const [batch] = await db
    .insert(postBatches)
    .values({ userId: user.id, name: 'App-managed sweep test batch' })
    .returning();
  if (!batch) throw new Error('failed to insert test batch');

  const [media] = await db
    .insert(mediaAssets)
    .values({
      userId: user.id,
      originalFilename: 'clip.mp4',
      storageKey: `${user.id}/unused.mp4`,
      fileSizeBytes: 1,
    })
    .returning();
  if (!media) throw new Error('failed to insert test media asset');

  const [item] = await db
    .insert(postItems)
    .values({ batchId: batch.id, mediaAssetId: media.id, defaultCaption: 'Sweep test caption' })
    .returning();
  if (!item) throw new Error('failed to insert test post item');

  const [postTarget] = await db
    .insert(postTargets)
    .values({ postItemId: item.id, publishTargetId: target.id, status, scheduledAt })
    .returning();
  if (!postTarget) throw new Error('failed to insert test post target');

  return { postTarget, publishTarget: target };
}

describe.skipIf(!ready)('enqueueDueAppManagedPublishJobs', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    const db = getDb();
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
    const userIds = testUsers.map((u) => u.id);
    if (userIds.length > 0) {
      const batches = await db
        .select({ id: postBatches.id })
        .from(postBatches)
        .where(inArray(postBatches.userId, userIds));
      const batchIds = batches.map((b) => b.id);
      if (batchIds.length > 0) {
        const items = await db
          .select({ id: postItems.id })
          .from(postItems)
          .where(inArray(postItems.batchId, batchIds));
        const itemIds = items.map((i) => i.id);
        if (itemIds.length > 0) {
          await db.delete(postTargets).where(inArray(postTargets.postItemId, itemIds));
          await db.delete(postItems).where(inArray(postItems.id, itemIds));
        }
        await db.delete(postBatches).where(inArray(postBatches.id, batchIds));
      }
      await db.delete(mediaAssets).where(inArray(mediaAssets.userId, userIds));
      await db.delete(publishTargets).where(inArray(publishTargets.userId, userIds));
      await db.delete(platformConnections).where(inArray(platformConnections.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await getPool().end();
  });

  it('enqueues due awaiting_app_managed_publish rows and flips them to queued, leaving future/other rows alone', async () => {
    const due = await createPostTarget(
      `${TEST_EMAIL_PREFIX}due-${Date.now()}@example.com`,
      new Date(Date.now() - 1000),
      'awaiting_app_managed_publish',
    );
    const future = await createPostTarget(
      `${TEST_EMAIL_PREFIX}future-${Date.now()}@example.com`,
      new Date(Date.now() + 60 * 60 * 1000),
      'awaiting_app_managed_publish',
    );
    const alreadyPublished = await createPostTarget(
      `${TEST_EMAIL_PREFIX}published-${Date.now()}@example.com`,
      new Date(Date.now() - 1000),
      'published',
    );

    await enqueueDueAppManagedPublishJobs();

    const dueQueue = getQueue<{ postTargetId: string }>(
      publishToTargetQueueName('instagram_business', due.publishTarget.externalId),
    );
    const dueJobs = await dueQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(dueJobs.some((job) => job.data.postTargetId === due.postTarget.id)).toBe(true);
    await Promise.all(
      dueJobs
        .filter((job) => job.data.postTargetId === due.postTarget.id)
        .map((job) => job.remove()),
    );

    const futureQueue = getQueue<{ postTargetId: string }>(
      publishToTargetQueueName('instagram_business', future.publishTarget.externalId),
    );
    const futureJobs = await futureQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(futureJobs.some((job) => job.data.postTargetId === future.postTarget.id)).toBe(false);

    const db = getDb();
    const [dueRow] = await db
      .select()
      .from(postTargets)
      .where(eq(postTargets.id, due.postTarget.id));
    expect(dueRow?.status).toBe('queued');

    const [futureRow] = await db
      .select()
      .from(postTargets)
      .where(eq(postTargets.id, future.postTarget.id));
    expect(futureRow?.status).toBe('awaiting_app_managed_publish');

    const [publishedRow] = await db
      .select()
      .from(postTargets)
      .where(eq(postTargets.id, alreadyPublished.postTarget.id));
    expect(publishedRow?.status).toBe('published');
  });

  it('logs an alert for a row found more than the late threshold past scheduled_at, but still enqueues it', async () => {
    process.env.APP_MANAGED_PUBLISH_LATE_THRESHOLD_MINUTES = '1';

    const late = await createPostTarget(
      `${TEST_EMAIL_PREFIX}late-${Date.now()}@example.com`,
      new Date(Date.now() - 5 * 60 * 1000),
      'awaiting_app_managed_publish',
    );

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueueDueAppManagedPublishJobs();

    expect(errorSpy).toHaveBeenCalledWith(
      '[app-managed-publish-late]',
      expect.objectContaining({ postTargetId: late.postTarget.id }),
    );

    const queue = getQueue<{ postTargetId: string }>(
      publishToTargetQueueName('instagram_business', late.publishTarget.externalId),
    );
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.some((job) => job.data.postTargetId === late.postTarget.id)).toBe(true);
    await Promise.all(
      jobs.filter((job) => job.data.postTargetId === late.postTarget.id).map((job) => job.remove()),
    );

    delete process.env.APP_MANAGED_PUBLISH_LATE_THRESHOLD_MINUTES;
  });
});

import 'dotenv/config';
import {
  encrypt,
  getDb,
  getPool,
  getQueue,
  mediaAssets,
  platformConnections,
  POLL_STATUS_QUEUE_NAME,
  postBatches,
  postItems,
  postTargets,
  publishTargets,
  users,
} from '@reelbridge/shared';
import { inArray, like } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { enqueueDuePollStatusJobs } from './pollStatusSweep.js';

process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';

const TEST_EMAIL_PREFIX = 'reelbridge-poll-sweep-test+';

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

async function createPostTarget(email: string, status: 'native_scheduled' | 'published') {
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
      platform: 'facebook_page',
      externalId: `page-${email}`,
      displayName: 'Sweep Test Page',
      accessTokenCiphertext: encryptedToken.ciphertext,
      accessTokenIv: encryptedToken.iv,
      accessTokenTag: encryptedToken.tag,
    })
    .returning();
  if (!target) throw new Error('failed to insert test target');

  const [batch] = await db
    .insert(postBatches)
    .values({ userId: user.id, name: 'Sweep test batch' })
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
    .values({
      postItemId: item.id,
      publishTargetId: target.id,
      status,
      platformPostId: status === 'native_scheduled' ? `fb-video-${email}` : undefined,
    })
    .returning();
  if (!postTarget) throw new Error('failed to insert test post target');

  return postTarget;
}

describe.skipIf(!ready)('enqueueDuePollStatusJobs', () => {
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

  it('enqueues only native_scheduled post_targets, leaving others alone', async () => {
    const scheduled = await createPostTarget(
      `${TEST_EMAIL_PREFIX}scheduled-${Date.now()}@example.com`,
      'native_scheduled',
    );
    const published = await createPostTarget(
      `${TEST_EMAIL_PREFIX}published-${Date.now()}@example.com`,
      'published',
    );

    await enqueueDuePollStatusJobs();

    const queue = getQueue<{ postTargetId: string }>(POLL_STATUS_QUEUE_NAME);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    const enqueuedIds = jobs.map((job) => job.data.postTargetId);

    expect(enqueuedIds).toContain(scheduled.id);
    expect(enqueuedIds).not.toContain(published.id);

    await Promise.all(
      jobs
        .filter(
          (job) => job.data.postTargetId === scheduled.id || job.data.postTargetId === published.id,
        )
        .map((job) => job.remove()),
    );
  });
});

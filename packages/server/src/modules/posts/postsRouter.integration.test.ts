import 'dotenv/config';
import {
  encrypt,
  getDb,
  getOrCreateWorker,
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
  type PublishToTargetJobData,
} from '@reelbridge/shared';
import type { Job, Worker } from 'bullmq';
import { inArray, like } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { signAccessToken } from '../auth/jwt.js';

process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';
process.env.JWT_SECRET ||= 'test-jwt-secret-for-integration-tests-only';

const TEST_EMAIL_PREFIX = 'reelbridge-posts-test+';

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

async function setupUser(emailSuffix: string) {
  const db = getDb();
  const email = `${TEST_EMAIL_PREFIX}${emailSuffix}-${Date.now()}-${Math.random()}@example.com`;
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

  return { user, connection, cookie: `reelbridge_access_token=${signAccessToken(user.id)}` };
}

async function createTarget(
  userId: string,
  connectionId: string,
  platform: 'facebook_page' | 'instagram_business',
) {
  const db = getDb();
  const encryptedToken = encrypt('token');
  const [target] = await db
    .insert(publishTargets)
    .values({
      userId,
      platformConnectionId: connectionId,
      platform,
      externalId: `${platform}-${Date.now()}-${Math.random()}`,
      displayName: `Test ${platform}`,
      accessTokenCiphertext: encryptedToken.ciphertext,
      accessTokenIv: encryptedToken.iv,
      accessTokenTag: encryptedToken.tag,
    })
    .returning();
  if (!target) throw new Error('failed to insert test target');
  return target;
}

async function createPostTarget(
  userId: string,
  publishTargetId: string,
  status: 'pending' | 'queued' | 'native_scheduled' | 'published' | 'failed',
  overrides: Partial<typeof postTargets.$inferInsert> = {},
) {
  const db = getDb();
  const [batch] = await db
    .insert(postBatches)
    .values({ userId, name: 'Posts test batch' })
    .returning();
  if (!batch) throw new Error('failed to insert test batch');

  const [media] = await db
    .insert(mediaAssets)
    .values({
      userId,
      originalFilename: 'clip.mp4',
      storageKey: `${userId}/${Date.now()}-${Math.random()}.mp4`,
      fileSizeBytes: 1000,
    })
    .returning();
  if (!media) throw new Error('failed to insert test media asset');

  const [item] = await db
    .insert(postItems)
    .values({ batchId: batch.id, mediaAssetId: media.id, defaultCaption: 'Default caption' })
    .returning();
  if (!item) throw new Error('failed to insert test post item');

  const [postTarget] = await db
    .insert(postTargets)
    .values({ postItemId: item.id, publishTargetId, status, ...overrides })
    .returning();
  if (!postTarget) throw new Error('failed to insert test post target');
  return postTarget;
}

function waitForWorkerFailed(
  worker: Worker<PublishToTargetJobData>,
  postTargetId: string,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.off('failed', handler);
      reject(new Error('timed out waiting for job to fail'));
    }, timeoutMs);
    const handler = (job: Job<PublishToTargetJobData> | undefined) => {
      if (job?.data.postTargetId === postTargetId) {
        clearTimeout(timeout);
        worker.off('failed', handler);
        resolve();
      }
    };
    worker.on('failed', handler);
  });
}

// Deletes every row this file created, keyed off the shared email prefix.
// Called once, from the last describe block's afterAll below — closing the
// shared pg pool here too, in the middle of the file, would break every
// later describe block that still needs it.
async function cleanupTestData(): Promise<void> {
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
}

describe.skipIf(!ready)('GET /api/posts', () => {
  const app = createApp();

  afterAll(async () => {
    await cleanupTestData();
  });

  it('scopes results to the caller and supports platform/status/target filters', async () => {
    const { user, connection, cookie } = await setupUser('filters');
    const fbTarget = await createTarget(user.id, connection.id, 'facebook_page');
    const igTarget = await createTarget(user.id, connection.id, 'instagram_business');

    const published = await createPostTarget(user.id, fbTarget.id, 'published');
    const failed = await createPostTarget(user.id, fbTarget.id, 'failed', {
      lastError: 'Upload timed out',
    });
    const scheduled = await createPostTarget(user.id, igTarget.id, 'native_scheduled');

    const other = await setupUser('other-owner');
    const otherTarget = await createTarget(other.user.id, other.connection.id, 'facebook_page');
    await createPostTarget(other.user.id, otherTarget.id, 'published');

    const allRes = await request(app).get('/api/posts').set('Cookie', cookie);
    expect(allRes.status).toBe(200);
    const allIds = allRes.body.posts.map((p: { id: string }) => p.id);
    expect(allIds.sort()).toEqual([published.id, failed.id, scheduled.id].sort());

    const platformRes = await request(app)
      .get('/api/posts?platform=facebook_page')
      .set('Cookie', cookie);
    expect(platformRes.body.posts.map((p: { id: string }) => p.id).sort()).toEqual(
      [published.id, failed.id].sort(),
    );

    const statusRes = await request(app).get('/api/posts?status=failed').set('Cookie', cookie);
    expect(statusRes.body.posts).toHaveLength(1);
    expect(statusRes.body.posts[0]).toMatchObject({
      id: failed.id,
      status: 'failed',
      lastError: 'Upload timed out',
    });

    const targetRes = await request(app)
      .get(`/api/posts?target=${igTarget.id}`)
      .set('Cookie', cookie);
    expect(targetRes.body.posts.map((p: { id: string }) => p.id)).toEqual([scheduled.id]);
  });

  it('paginates via cursor without omitting or duplicating rows', async () => {
    const { user, connection, cookie } = await setupUser('pagination');
    const fbTarget = await createTarget(user.id, connection.id, 'facebook_page');
    const created = [];
    for (let i = 0; i < 3; i++) {
      created.push(await createPostTarget(user.id, fbTarget.id, 'pending'));
    }

    const seenIds = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await request(app)
        .get(`/api/posts?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.posts).toHaveLength(1);
      seenIds.add(res.body.posts[0].id);
      cursor = res.body.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);

    expect(seenIds).toEqual(new Set(created.map((row) => row.id)));
  });

  it('is 400 for an invalid cursor', async () => {
    const { cookie } = await setupUser('bad-cursor');
    const res = await request(app).get('/api/posts?cursor=not-a-real-cursor').set('Cookie', cookie);
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!ready)('POST /api/posts/:id/retry', () => {
  const app = createApp();

  afterAll(async () => {
    await cleanupTestData();
    await getPool().end();
  });

  it('rejects retrying a post that is not in a failed state', async () => {
    const { user, connection, cookie } = await setupUser('not-failed');
    const fbTarget = await createTarget(user.id, connection.id, 'facebook_page');
    const published = await createPostTarget(user.id, fbTarget.id, 'published');

    const res = await request(app).post(`/api/posts/${published.id}/retry`).set('Cookie', cookie);
    expect(res.status).toBe(400);
  });

  it('is 404 for a post target belonging to another user', async () => {
    const owner = await setupUser('retry-owner');
    const ownerTarget = await createTarget(owner.user.id, owner.connection.id, 'facebook_page');
    const failed = await createPostTarget(owner.user.id, ownerTarget.id, 'failed');

    const other = await setupUser('retry-other');
    const res = await request(app)
      .post(`/api/posts/${failed.id}/retry`)
      .set('Cookie', other.cookie);
    expect(res.status).toBe(404);
  });

  it('re-enqueues a failed post with no existing job and resets its status', async () => {
    const { user, connection, cookie } = await setupUser('retry-fresh');
    const fbTarget = await createTarget(user.id, connection.id, 'facebook_page');
    const failed = await createPostTarget(user.id, fbTarget.id, 'failed', {
      lastError: 'Something went wrong',
      attemptCount: 5,
    });

    const res = await request(app).post(`/api/posts/${failed.id}/retry`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: failed.id, status: 'queued', lastError: null });

    const queue = getQueue<PublishToTargetJobData>(
      publishToTargetQueueName('facebook_page', fbTarget.externalId),
    );
    const job = await queue.getJob(failed.id);
    expect(job).toBeDefined();
    await job?.remove();
  });

  it('retries a job that already ran to failure in BullMQ, reprocessing it rather than being a no-op', async () => {
    const { user, connection, cookie } = await setupUser('retry-inflight');
    const fbTarget = await createTarget(user.id, connection.id, 'facebook_page');
    const failed = await createPostTarget(user.id, fbTarget.id, 'failed');

    const queueName = publishToTargetQueueName('facebook_page', fbTarget.externalId);
    let processCount = 0;
    const worker = getOrCreateWorker<PublishToTargetJobData>(queueName, async () => {
      processCount += 1;
      throw new Error('simulated publish failure');
    });

    const queue = getQueue<PublishToTargetJobData>(queueName);
    await queue.add('publish', { postTargetId: failed.id }, { jobId: failed.id, attempts: 1 });
    await waitForWorkerFailed(worker, failed.id);
    expect(processCount).toBe(1);

    // Registered before sending the request: the in-process worker can pick
    // up and fail the retried job while the HTTP response is still in
    // flight, so listening only starts after `await request(...)` resolves
    // would race the 'failed' event and miss it.
    const secondFailure = waitForWorkerFailed(worker, failed.id);
    const res = await request(app).post(`/api/posts/${failed.id}/retry`).set('Cookie', cookie);
    expect(res.status).toBe(200);

    // A no-op retry would never reprocess the job — this is the behavior
    // that distinguishes retryPublishToTarget from a plain enqueue call,
    // which BullMQ ignores for a jobId that already exists.
    await secondFailure;
    expect(processCount).toBe(2);

    await worker.close();
    const job = await queue.getJob(failed.id);
    await job?.remove();
  }, 15000);
});

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
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { signAccessToken } from '../auth/jwt.js';

process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';
process.env.JWT_SECRET ||= 'test-jwt-secret-for-integration-tests-only';

const TEST_EMAIL_PREFIX = 'reelbridge-publish-test+';

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

async function createTarget(
  userId: string,
  connectionId: string,
  platform: 'facebook_page' | 'instagram_business',
  options: { isActive?: boolean } = {},
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
      isActive: options.isActive ?? true,
    })
    .returning();
  if (!target) throw new Error('failed to insert test target');
  return target;
}

describe.skipIf(!ready)('POST /api/batches/:id/publish', () => {
  const app = createApp();

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

  it('enqueues a job per row, marks post_targets queued, and marks the batch active', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}${Date.now()}@example.com`;
    const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
    if (!user) throw new Error('failed to insert test user');
    const cookie = `reelbridge_access_token=${signAccessToken(user.id)}`;

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

    const fbTarget = await createTarget(user.id, connection.id, 'facebook_page');

    const [media] = await db
      .insert(mediaAssets)
      .values({
        userId: user.id,
        originalFilename: 'clip.mp4',
        storageKey: `${user.id}/clip.mp4`,
        fileSizeBytes: 1000,
        durationSeconds: 30,
        width: 1080,
        height: 1920,
      })
      .returning();
    if (!media) throw new Error('failed to insert test media asset');

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', cookie)
      .send({ name: 'Publish batch' });
    const batchId = batchRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', cookie)
      .send({ media_asset_id: media.id, default_caption: 'Default caption' });
    const itemId = itemRes.body.id as string;

    const targetRes = await request(app)
      .post(`/api/batches/${batchId}/items/${itemId}/targets`)
      .set('Cookie', cookie)
      .send({ targets: [{ publish_target_id: fbTarget.id }] });
    const postTargetId = targetRes.body.created[0].id as string;

    const publishRes = await request(app)
      .post(`/api/batches/${batchId}/publish`)
      .set('Cookie', cookie);

    expect(publishRes.status).toBe(200);
    expect(publishRes.body).toEqual({
      batchId,
      queuedCount: 1,
      postTargetIds: [postTargetId],
      failedPostTargetIds: [],
    });

    const queue = getQueue<{ postTargetId: string }>(
      publishToTargetQueueName('facebook_page', fbTarget.externalId),
    );
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    const matchingJobs = jobs.filter((job) => job.data.postTargetId === postTargetId);
    expect(matchingJobs).toHaveLength(1);
    await Promise.all(matchingJobs.map((job) => job.remove()));

    const [updatedTarget] = await db
      .select()
      .from(postTargets)
      .where(eq(postTargets.id, postTargetId));
    expect(updatedTarget?.status).toBe('queued');

    const [updatedBatch] = await db.select().from(postBatches).where(eq(postBatches.id, batchId));
    expect(updatedBatch?.status).toBe('active');
  });

  it('calling publish a second time does not re-enqueue an already-queued row', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}double-${Date.now()}@example.com`;
    const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
    if (!user) throw new Error('failed to insert test user');
    const cookie = `reelbridge_access_token=${signAccessToken(user.id)}`;

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

    const fbTarget = await createTarget(user.id, connection.id, 'facebook_page');

    const [media] = await db
      .insert(mediaAssets)
      .values({
        userId: user.id,
        originalFilename: 'clip.mp4',
        storageKey: `${user.id}/clip.mp4`,
        fileSizeBytes: 1000,
        durationSeconds: 30,
        width: 1080,
        height: 1920,
      })
      .returning();
    if (!media) throw new Error('failed to insert test media asset');

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', cookie)
      .send({ name: 'Double publish batch' });
    const batchId = batchRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', cookie)
      .send({ media_asset_id: media.id, default_caption: 'Default caption' });
    const itemId = itemRes.body.id as string;

    const targetRes = await request(app)
      .post(`/api/batches/${batchId}/items/${itemId}/targets`)
      .set('Cookie', cookie)
      .send({ targets: [{ publish_target_id: fbTarget.id }] });
    const postTargetId = targetRes.body.created[0].id as string;

    const firstPublish = await request(app)
      .post(`/api/batches/${batchId}/publish`)
      .set('Cookie', cookie);
    expect(firstPublish.status).toBe(200);
    expect(firstPublish.body.queuedCount).toBe(1);

    // A second call — a double-click, a client retry, a second tab — sees the
    // row as no longer 'pending' and must not enqueue a duplicate job.
    const secondPublish = await request(app)
      .post(`/api/batches/${batchId}/publish`)
      .set('Cookie', cookie);
    expect(secondPublish.status).toBe(400);
    expect(secondPublish.body).toEqual({ error: 'Nothing to publish' });

    const queue = getQueue<{ postTargetId: string }>(
      publishToTargetQueueName('facebook_page', fbTarget.externalId),
    );
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
    const matchingJobs = jobs.filter((job) => job.data.postTargetId === postTargetId);
    expect(matchingJobs).toHaveLength(1);
    await Promise.all(matchingJobs.map((job) => job.remove()));
  });

  it('rejects with 409 and enqueues nothing when a row is blocking (inactive target)', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}blocking-${Date.now()}@example.com`;
    const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
    if (!user) throw new Error('failed to insert test user');
    const cookie = `reelbridge_access_token=${signAccessToken(user.id)}`;

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

    const inactiveTarget = await createTarget(user.id, connection.id, 'facebook_page', {
      isActive: false,
    });

    const [media] = await db
      .insert(mediaAssets)
      .values({
        userId: user.id,
        originalFilename: 'clip.mp4',
        storageKey: `${user.id}/clip.mp4`,
        fileSizeBytes: 1000,
        durationSeconds: 30,
        width: 1080,
        height: 1920,
      })
      .returning();
    if (!media) throw new Error('failed to insert test media asset');

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', cookie)
      .send({ name: 'Blocking publish batch' });
    const batchId = batchRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', cookie)
      .send({ media_asset_id: media.id, default_caption: 'caption' });
    const itemId = itemRes.body.id as string;

    const targetRes = await request(app)
      .post(`/api/batches/${batchId}/items/${itemId}/targets`)
      .set('Cookie', cookie)
      .send({ targets: [{ publish_target_id: inactiveTarget.id }] });
    const postTargetId = targetRes.body.created[0].id as string;

    const publishRes = await request(app)
      .post(`/api/batches/${batchId}/publish`)
      .set('Cookie', cookie);

    expect(publishRes.status).toBe(409);
    expect(publishRes.body).toEqual({
      error: 'Resolve blocking issues before scheduling this batch.',
      blockingCount: 1,
    });

    const [updatedTarget] = await db
      .select()
      .from(postTargets)
      .where(eq(postTargets.id, postTargetId));
    expect(updatedTarget?.status).toBe('pending');

    const queue = getQueue<{ postTargetId: string }>(
      publishToTargetQueueName('facebook_page', inactiveTarget.externalId),
    );
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.some((job) => job.data.postTargetId === postTargetId)).toBe(false);
  });

  it('is 404 for a batch belonging to another user', async () => {
    const db = getDb();
    const [owner] = await db
      .insert(users)
      .values({
        email: `${TEST_EMAIL_PREFIX}owner-${Date.now()}@example.com`,
        passwordHash: 'unused',
      })
      .returning();
    const [other] = await db
      .insert(users)
      .values({
        email: `${TEST_EMAIL_PREFIX}other-${Date.now()}@example.com`,
        passwordHash: 'unused',
      })
      .returning();
    if (!owner || !other) throw new Error('failed to insert test users');

    const ownerCookie = `reelbridge_access_token=${signAccessToken(owner.id)}`;
    const otherCookie = `reelbridge_access_token=${signAccessToken(other.id)}`;

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', ownerCookie)
      .send({ name: 'Private publish batch' });
    const batchId = batchRes.body.id as string;

    const res = await request(app)
      .post(`/api/batches/${batchId}/publish`)
      .set('Cookie', otherCookie);
    expect(res.status).toBe(404);
  });

  // Instagram has no platform-side scheduling (TDD.md §1.2) — a container
  // simply expires 24h after creation. Enqueuing the real publish job at
  // /publish time for a future scheduledAt would run it immediately instead
  // of at the intended time (adapter.publish() ignores scheduledAt), which is
  // exactly the bug issue #34 fixes: the row must sit in
  // awaiting_app_managed_publish, untouched by BullMQ, until the due-job
  // sweep (cron/appManagedPublishSweep.ts) picks it up.
  it('defers a future-scheduled Instagram row to awaiting_app_managed_publish instead of enqueuing it', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}ig-future-${Date.now()}@example.com`;
    const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
    if (!user) throw new Error('failed to insert test user');
    const cookie = `reelbridge_access_token=${signAccessToken(user.id)}`;

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

    const igTarget = await createTarget(user.id, connection.id, 'instagram_business');

    const [media] = await db
      .insert(mediaAssets)
      .values({
        userId: user.id,
        originalFilename: 'clip.mp4',
        storageKey: `${user.id}/clip.mp4`,
        fileSizeBytes: 1000,
        durationSeconds: 30,
        width: 1080,
        height: 1920,
      })
      .returning();
    if (!media) throw new Error('failed to insert test media asset');

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', cookie)
      .send({ name: 'Instagram future publish batch' });
    const batchId = batchRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', cookie)
      .send({ media_asset_id: media.id, default_caption: 'Default caption' });
    const itemId = itemRes.body.id as string;

    const futureScheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const targetRes = await request(app)
      .post(`/api/batches/${batchId}/items/${itemId}/targets`)
      .set('Cookie', cookie)
      .send({
        targets: [{ publish_target_id: igTarget.id, scheduled_at: futureScheduledAt }],
      });
    const postTargetId = targetRes.body.created[0].id as string;

    const publishRes = await request(app)
      .post(`/api/batches/${batchId}/publish`)
      .set('Cookie', cookie);

    expect(publishRes.status).toBe(200);
    expect(publishRes.body).toEqual({
      batchId,
      queuedCount: 1,
      postTargetIds: [postTargetId],
      failedPostTargetIds: [],
    });

    const queue = getQueue<{ postTargetId: string }>(
      publishToTargetQueueName('instagram_business', igTarget.externalId),
    );
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.some((job) => job.data.postTargetId === postTargetId)).toBe(false);

    const [updatedTarget] = await db
      .select()
      .from(postTargets)
      .where(eq(postTargets.id, postTargetId));
    expect(updatedTarget?.status).toBe('awaiting_app_managed_publish');
  });

  it('enqueues an Instagram row immediately when it has no scheduledAt (post now)', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}ig-now-${Date.now()}@example.com`;
    const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
    if (!user) throw new Error('failed to insert test user');
    const cookie = `reelbridge_access_token=${signAccessToken(user.id)}`;

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

    const igTarget = await createTarget(user.id, connection.id, 'instagram_business');

    const [media] = await db
      .insert(mediaAssets)
      .values({
        userId: user.id,
        originalFilename: 'clip.mp4',
        storageKey: `${user.id}/clip.mp4`,
        fileSizeBytes: 1000,
        durationSeconds: 30,
        width: 1080,
        height: 1920,
      })
      .returning();
    if (!media) throw new Error('failed to insert test media asset');

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', cookie)
      .send({ name: 'Instagram now publish batch' });
    const batchId = batchRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', cookie)
      .send({ media_asset_id: media.id, default_caption: 'Default caption' });
    const itemId = itemRes.body.id as string;

    const targetRes = await request(app)
      .post(`/api/batches/${batchId}/items/${itemId}/targets`)
      .set('Cookie', cookie)
      .send({ targets: [{ publish_target_id: igTarget.id }] });
    const postTargetId = targetRes.body.created[0].id as string;

    const publishRes = await request(app)
      .post(`/api/batches/${batchId}/publish`)
      .set('Cookie', cookie);

    expect(publishRes.status).toBe(200);
    expect(publishRes.body.queuedCount).toBe(1);

    const queue = getQueue<{ postTargetId: string }>(
      publishToTargetQueueName('instagram_business', igTarget.externalId),
    );
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    const matchingJobs = jobs.filter((job) => job.data.postTargetId === postTargetId);
    expect(matchingJobs).toHaveLength(1);
    await Promise.all(matchingJobs.map((job) => job.remove()));

    const [updatedTarget] = await db
      .select()
      .from(postTargets)
      .where(eq(postTargets.id, postTargetId));
    expect(updatedTarget?.status).toBe('queued');
  });
});

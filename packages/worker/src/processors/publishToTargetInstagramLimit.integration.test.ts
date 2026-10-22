import 'dotenv/config';
import {
  createStorageAdapterFromEnv,
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
  publishTargets,
  publishToTargetQueueName,
  users,
  type PublishToTargetJobData,
} from '@reelbridge/shared';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { eq, inArray, like } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { processPublishToTarget } from './publishToTarget.js';

process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';
const TEST_EMAIL_PREFIX = 'reelbridge-ig-limit-test+';

async function isDatabaseReachable(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
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
async function isStorageReachable(): Promise<boolean> {
  if (!process.env.S3_BUCKET || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY)
    return false;
  const client = new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }));
    return true;
  } catch {
    return false;
  } finally {
    client.destroy();
  }
}
const ready = (
  await Promise.all([isDatabaseReachable(), isRedisReachable(), isStorageReachable()])
).every(Boolean);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe.skipIf(!ready)('processPublishToTarget (Instagram publishing limit, issue #35)', () => {
  afterEach(() => vi.unstubAllGlobals());
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

  it('defers (delayed job, status stays queued) when content_publishing_limit is exhausted, without creating a container', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}${Date.now()}@example.com`;
    const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
    const [conn] = await db
      .insert(platformConnections)
      .values({
        userId: user!.id,
        platform: 'facebook',
        externalAccountId: 'me',
        displayName: 'FB',
        accessTokenCiphertext: 'x',
        accessTokenIv: 'x',
        accessTokenTag: 'x',
      })
      .returning();
    const pageToken = encrypt('page-token');
    const pageId = `page-limit-${Date.now()}`;
    await db.insert(publishTargets).values({
      userId: user!.id,
      platformConnectionId: conn!.id,
      platform: 'facebook_page',
      externalId: pageId,
      displayName: 'Page',
      accessTokenCiphertext: pageToken.ciphertext,
      accessTokenIv: pageToken.iv,
      accessTokenTag: pageToken.tag,
    });
    const igId = `ig-limit-${Date.now()}`;
    const [ig] = await db
      .insert(publishTargets)
      .values({
        userId: user!.id,
        platformConnectionId: conn!.id,
        platform: 'instagram_business',
        externalId: igId,
        displayName: 'IG',
        metadata: { linkedFacebookPageId: pageId },
      })
      .returning();
    const storageKey = `${user!.id}/ig-limit.mp4`;
    await createStorageAdapterFromEnv().save(storageKey, Buffer.from('bytes'), 'video/mp4');
    const [media] = await db
      .insert(mediaAssets)
      .values({ userId: user!.id, originalFilename: 'a.mp4', storageKey, fileSizeBytes: 5 })
      .returning();
    const [batch] = await db
      .insert(postBatches)
      .values({ userId: user!.id, name: 'b' })
      .returning();
    const [item] = await db
      .insert(postItems)
      .values({ batchId: batch!.id, mediaAssetId: media!.id, defaultCaption: 'c' })
      .returning();
    const [postTarget] = await db
      .insert(postTargets)
      .values({ postItemId: item!.id, publishTargetId: ig!.id, status: 'queued' })
      .returning();

    let containerCreated = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = input.toString();
        if (url.includes('/content_publishing_limit')) {
          return jsonResponse({ data: [{ quota_usage: 100, config: { quota_total: 100 } }] });
        }
        if (url.includes(`/${igId}/media`)) containerCreated = true;
        throw new Error(`Unexpected fetch call: ${url}`);
      }),
    );

    // Through a real Queue+Worker: moveToDelayed needs a live lock token.
    const queueName = publishToTargetQueueName('instagram_business', igId);
    const queue = getQueue<PublishToTargetJobData>(queueName);
    const worker = getOrCreateWorker<PublishToTargetJobData>(queueName, (job, token) =>
      processPublishToTarget(job, token),
    );
    try {
      await queue.add(
        'publish',
        { postTargetId: postTarget!.id },
        { jobId: postTarget!.id, attempts: 3 },
      );
      await vi.waitFor(
        async () => {
          const job = await queue.getJob(postTarget!.id);
          expect(await job?.getState()).toBe('delayed');
        },
        { timeout: 15_000, interval: 200 },
      );
      const job = await queue.getJob(postTarget!.id);
      // Deferred, not failed: no attempt consumed.
      expect(job?.attemptsMade).toBe(0);
      expect(containerCreated).toBe(false);

      const [row] = await db.select().from(postTargets).where(eq(postTargets.id, postTarget!.id));
      expect(row?.status).toBe('queued');
      expect(row?.lastError).toMatch(/100 API posts per 24 hours/);
      await job?.remove();
    } finally {
      await worker.close();
      await queue.obliterate({ force: true }).catch(() => {});
    }
  });
});

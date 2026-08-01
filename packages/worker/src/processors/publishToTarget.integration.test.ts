import 'dotenv/config';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { PublishToTargetJobData } from '@reelbridge/shared';
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
} from '@reelbridge/shared';
import { eq, inArray, like } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { processPublishToTarget } from './publishToTarget.js';

process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';
process.env.GOOGLE_CLIENT_ID ||= 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET ||= 'test-google-client-secret';

const TEST_EMAIL_PREFIX = 'reelbridge-publish-processor-test+';

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

async function isStorageReachable(): Promise<boolean> {
  if (
    !process.env.S3_BUCKET ||
    !process.env.S3_ACCESS_KEY_ID ||
    !process.env.S3_SECRET_ACCESS_KEY
  ) {
    return false;
  }
  try {
    const client = new S3Client({
      region: process.env.S3_REGION,
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
    await client.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }));
    return true;
  } catch {
    return false;
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

const [dbReachable, storageReachable, redisReachable] = await Promise.all([
  isDatabaseReachable(),
  isStorageReachable(),
  isRedisReachable(),
]);
const ready = dbReachable && storageReachable;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe.skipIf(!ready)('processPublishToTarget (Facebook)', () => {
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
    // Pool close deferred to the last describe block's afterAll (below) —
    // closing it here would break the YouTube describe block that still
    // needs it, since describe blocks in this file run sequentially.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads media from storage, publishes via the Facebook adapter, and updates post_targets', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}${Date.now()}@example.com`;
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

    const encryptedToken = encrypt('real-page-access-token');
    const [target] = await db
      .insert(publishTargets)
      .values({
        userId: user.id,
        platformConnectionId: connection.id,
        platform: 'facebook_page',
        externalId: 'page-processor-test',
        displayName: 'Processor Test Page',
        accessTokenCiphertext: encryptedToken.ciphertext,
        accessTokenIv: encryptedToken.iv,
        accessTokenTag: encryptedToken.tag,
      })
      .returning();
    if (!target) throw new Error('failed to insert test target');

    const storageKey = `${user.id}/processor-test.mp4`;
    const videoBytes = Buffer.from('fake-video-bytes-for-processor-test');
    const storage = createStorageAdapterFromEnv();
    await storage.save(storageKey, videoBytes, 'video/mp4');

    const [media] = await db
      .insert(mediaAssets)
      .values({
        userId: user.id,
        originalFilename: 'clip.mp4',
        storageKey,
        fileSizeBytes: videoBytes.length,
      })
      .returning();
    if (!media) throw new Error('failed to insert test media asset');

    const [batch] = await db
      .insert(postBatches)
      .values({ userId: user.id, name: 'Processor test batch' })
      .returning();
    if (!batch) throw new Error('failed to insert test batch');

    const [item] = await db
      .insert(postItems)
      .values({
        batchId: batch.id,
        mediaAssetId: media.id,
        defaultCaption: 'Processor test caption',
      })
      .returning();
    if (!item) throw new Error('failed to insert test post item');

    const [postTarget] = await db
      .insert(postTargets)
      .values({ postItemId: item.id, publishTargetId: target.id, status: 'pending' })
      .returning();
    if (!postTarget) throw new Error('failed to insert test post target');

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = input.toString();
      if (urlStr === 'https://upload.processor-test.example/video') {
        return jsonResponse({ success: true });
      }
      if (
        urlStr.includes('/page-processor-test/video_reels') &&
        init?.body instanceof URLSearchParams
      ) {
        const params = init.body;
        if (params.get('upload_phase') === 'start') {
          return jsonResponse({
            video_id: 'processor-test-video-id',
            upload_url: 'https://upload.processor-test.example/video',
          });
        }
        if (params.get('upload_phase') === 'finish') {
          expect(params.get('description')).toBe('Processor test caption');
          expect(params.get('video_state')).toBe('PUBLISHED');
          return jsonResponse({ success: true });
        }
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = {
      data: { postTargetId: postTarget.id } as PublishToTargetJobData,
    } as Job<PublishToTargetJobData>;
    await processPublishToTarget(job);

    const [updated] = await db.select().from(postTargets).where(eq(postTargets.id, postTarget.id));
    expect(updated?.status).toBe('published');
    expect(updated?.platformPostId).toBe('processor-test-video-id');
    expect(updated?.publishedAt).not.toBeNull();
    expect(updated?.lastError).toBeNull();
  });

  it('marks the post_target failed and rethrows when the adapter call fails', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}fail-${Date.now()}@example.com`;
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

    const encryptedToken = encrypt('real-page-access-token');
    const [target] = await db
      .insert(publishTargets)
      .values({
        userId: user.id,
        platformConnectionId: connection.id,
        platform: 'facebook_page',
        externalId: 'page-processor-fail-test',
        displayName: 'Processor Fail Test Page',
        accessTokenCiphertext: encryptedToken.ciphertext,
        accessTokenIv: encryptedToken.iv,
        accessTokenTag: encryptedToken.tag,
      })
      .returning();
    if (!target) throw new Error('failed to insert test target');

    const storageKey = `${user.id}/processor-fail-test.mp4`;
    const videoBytes = Buffer.from('fake-video-bytes-for-fail-test');
    await createStorageAdapterFromEnv().save(storageKey, videoBytes, 'video/mp4');

    const [media] = await db
      .insert(mediaAssets)
      .values({
        userId: user.id,
        originalFilename: 'clip.mp4',
        storageKey,
        fileSizeBytes: videoBytes.length,
      })
      .returning();
    if (!media) throw new Error('failed to insert test media asset');

    const [batch] = await db
      .insert(postBatches)
      .values({ userId: user.id, name: 'Processor fail test batch' })
      .returning();
    if (!batch) throw new Error('failed to insert test batch');

    const [item] = await db
      .insert(postItems)
      .values({ batchId: batch.id, mediaAssetId: media.id, defaultCaption: 'Fail test caption' })
      .returning();
    if (!item) throw new Error('failed to insert test post item');

    const [postTarget] = await db
      .insert(postTargets)
      .values({ postItemId: item.id, publishTargetId: target.id, status: 'pending' })
      .returning();
    if (!postTarget) throw new Error('failed to insert test post target');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'simulated Graph API failure' } }, 400)),
    );

    const job = {
      data: { postTargetId: postTarget.id } as PublishToTargetJobData,
    } as Job<PublishToTargetJobData>;
    await expect(processPublishToTarget(job)).rejects.toThrow();

    const [updated] = await db.select().from(postTargets).where(eq(postTargets.id, postTarget.id));
    expect(updated?.status).toBe('failed');
    expect(updated?.lastError).toBeDefined();
    expect(updated?.attemptCount).toBe(1);
  });
});

describe.skipIf(!ready)('processPublishToTarget (Instagram)', () => {
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
    // Pool close deferred to the last describe block's afterAll — closing it
    // here would break the describe blocks below that still need it, since
    // describe blocks in this file run sequentially.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a signed URL and the linked Facebook Page token, publishes via the container flow, and backfills the permalink', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}ig-${Date.now()}@example.com`;
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

    const encryptedPageToken = encrypt('linked-page-access-token');
    const [fbTarget] = await db
      .insert(publishTargets)
      .values({
        userId: user.id,
        platformConnectionId: connection.id,
        platform: 'facebook_page',
        externalId: 'page-linked-to-ig',
        displayName: 'Linked Page',
        accessTokenCiphertext: encryptedPageToken.ciphertext,
        accessTokenIv: encryptedPageToken.iv,
        accessTokenTag: encryptedPageToken.tag,
      })
      .returning();
    if (!fbTarget) throw new Error('failed to insert test facebook target');

    // instagram_business publish_targets rows stay tokenless in production —
    // upsertGoogleConnection.ts/shared/instagramTargets.ts — and carry the
    // linked Page's id in metadata instead.
    const [igTarget] = await db
      .insert(publishTargets)
      .values({
        userId: user.id,
        platformConnectionId: connection.id,
        platform: 'instagram_business',
        externalId: 'ig-user-processor-test',
        displayName: 'Processor Test IG Account',
        tokenSource: 'oauth',
        metadata: { linkedFacebookPageId: 'page-linked-to-ig' },
      })
      .returning();
    if (!igTarget) throw new Error('failed to insert test instagram target');

    const storageKey = `${user.id}/processor-test-ig.mp4`;
    const videoBytes = Buffer.from('fake-video-bytes-for-instagram-processor-test');
    await createStorageAdapterFromEnv().save(storageKey, videoBytes, 'video/mp4');

    const [media] = await db
      .insert(mediaAssets)
      .values({
        userId: user.id,
        originalFilename: 'clip.mp4',
        storageKey,
        fileSizeBytes: videoBytes.length,
      })
      .returning();
    if (!media) throw new Error('failed to insert test media asset');

    const [batch] = await db
      .insert(postBatches)
      .values({ userId: user.id, name: 'Instagram processor test batch' })
      .returning();
    if (!batch) throw new Error('failed to insert test batch');

    const [item] = await db
      .insert(postItems)
      .values({
        batchId: batch.id,
        mediaAssetId: media.id,
        defaultCaption: 'Instagram processor test caption',
      })
      .returning();
    if (!item) throw new Error('failed to insert test post item');

    const [postTarget] = await db
      .insert(postTargets)
      .values({ postItemId: item.id, publishTargetId: igTarget.id, status: 'pending' })
      .returning();
    if (!postTarget) throw new Error('failed to insert test post target');

    let sawSignedVideoUrl = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = input.toString();
      if (urlStr.includes('/ig-user-processor-test/media') && !urlStr.includes('media_publish')) {
        const params = init?.body as URLSearchParams;
        expect(params.get('access_token')).toBe('linked-page-access-token');
        // Real signed URLs from the local MinIO adapter are long, host the
        // storage key, and carry query-string auth params — just confirm
        // it's not the raw storage key or an empty value.
        expect(params.get('video_url')).toContain(storageKey);
        sawSignedVideoUrl = true;
        return jsonResponse({ id: 'container-processor-test' });
      }
      if (urlStr.includes('/container-processor-test')) {
        return jsonResponse({ status_code: 'FINISHED' });
      }
      if (urlStr.includes('/ig-user-processor-test/media_publish')) {
        return jsonResponse({ id: 'processor-test-ig-media-id' });
      }
      if (urlStr.includes('/processor-test-ig-media-id')) {
        return jsonResponse({ permalink: 'https://instagram.com/reel/processor-test/' });
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = {
      data: { postTargetId: postTarget.id } as PublishToTargetJobData,
    } as Job<PublishToTargetJobData>;
    await processPublishToTarget(job);

    expect(sawSignedVideoUrl).toBe(true);
    const [updated] = await db.select().from(postTargets).where(eq(postTargets.id, postTarget.id));
    expect(updated?.status).toBe('published');
    expect(updated?.platformPostId).toBe('processor-test-ig-media-id');
    expect(updated?.permalinkUrl).toBe('https://instagram.com/reel/processor-test/');
    expect(updated?.publishedAt).not.toBeNull();
    expect(updated?.lastError).toBeNull();
  });

  it('marks the post_target failed when the linked Facebook Page has no access token', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}ig-nopage-${Date.now()}@example.com`;
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

    // No facebook_page publish_targets row inserted at all — simulates a
    // linked page whose target row is missing/deactivated.
    const [igTarget] = await db
      .insert(publishTargets)
      .values({
        userId: user.id,
        platformConnectionId: connection.id,
        platform: 'instagram_business',
        externalId: 'ig-user-nopage-test',
        displayName: 'No Page Test IG Account',
        tokenSource: 'oauth',
        metadata: { linkedFacebookPageId: 'nonexistent-page' },
      })
      .returning();
    if (!igTarget) throw new Error('failed to insert test instagram target');

    const storageKey = `${user.id}/processor-nopage-ig.mp4`;
    const videoBytes = Buffer.from('fake-video-bytes-for-nopage-test');
    await createStorageAdapterFromEnv().save(storageKey, videoBytes, 'video/mp4');

    const [media] = await db
      .insert(mediaAssets)
      .values({
        userId: user.id,
        originalFilename: 'clip.mp4',
        storageKey,
        fileSizeBytes: videoBytes.length,
      })
      .returning();
    if (!media) throw new Error('failed to insert test media asset');

    const [batch] = await db
      .insert(postBatches)
      .values({ userId: user.id, name: 'No page test batch' })
      .returning();
    if (!batch) throw new Error('failed to insert test batch');

    const [item] = await db
      .insert(postItems)
      .values({ batchId: batch.id, mediaAssetId: media.id, defaultCaption: 'No page caption' })
      .returning();
    if (!item) throw new Error('failed to insert test post item');

    const [postTarget] = await db
      .insert(postTargets)
      .values({ postItemId: item.id, publishTargetId: igTarget.id, status: 'pending' })
      .returning();
    if (!postTarget) throw new Error('failed to insert test post target');

    const job = {
      data: { postTargetId: postTarget.id } as PublishToTargetJobData,
    } as Job<PublishToTargetJobData>;
    await expect(processPublishToTarget(job)).rejects.toThrow(/missing an access token/);

    const [updated] = await db.select().from(postTargets).where(eq(postTargets.id, postTarget.id));
    expect(updated?.status).toBe('failed');
  });
});

describe.skipIf(!ready)('processPublishToTarget (YouTube)', () => {
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
    // Pool close deferred to the last describe block's afterAll (below) —
    // closing it here would break the quota-backoff describe block that
    // still needs it, since describe blocks in this file run sequentially.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const UPLOAD_SESSION_URL = 'https://upload.processor-test.example/youtube-session';

  it('decrypts the connection-level refresh token (not a per-target token), uploads resumably via the YouTube adapter, and updates post_targets', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}yt-${Date.now()}@example.com`;
    const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
    if (!user) throw new Error('failed to insert test user');

    const encryptedAccessToken = encrypt('google-access-token');
    const encryptedRefreshToken = encrypt('google-refresh-token');
    const [connection] = await db
      .insert(platformConnections)
      .values({
        userId: user.id,
        platform: 'google',
        externalAccountId: 'me',
        displayName: 'Google',
        accessTokenCiphertext: encryptedAccessToken.ciphertext,
        accessTokenIv: encryptedAccessToken.iv,
        accessTokenTag: encryptedAccessToken.tag,
        refreshTokenCiphertext: encryptedRefreshToken.ciphertext,
        refreshTokenIv: encryptedRefreshToken.iv,
        refreshTokenTag: encryptedRefreshToken.tag,
      })
      .returning();
    if (!connection) throw new Error('failed to insert test connection');

    // publish_targets.access_token_ciphertext stays null for youtube_channel
    // rows in production (upsertGoogleConnection.ts) — asserting that here
    // by simply never setting it confirms the processor doesn't depend on it.
    const [target] = await db
      .insert(publishTargets)
      .values({
        userId: user.id,
        platformConnectionId: connection.id,
        platform: 'youtube_channel',
        externalId: 'channel-processor-test',
        displayName: 'Processor Test Channel',
        tokenSource: 'oauth',
      })
      .returning();
    if (!target) throw new Error('failed to insert test target');

    const storageKey = `${user.id}/processor-test-yt.mp4`;
    const videoBytes = Buffer.from('fake-video-bytes-for-youtube-processor-test');
    await createStorageAdapterFromEnv().save(storageKey, videoBytes, 'video/mp4');

    const [media] = await db
      .insert(mediaAssets)
      .values({
        userId: user.id,
        originalFilename: 'clip.mp4',
        storageKey,
        fileSizeBytes: videoBytes.length,
      })
      .returning();
    if (!media) throw new Error('failed to insert test media asset');

    const [batch] = await db
      .insert(postBatches)
      .values({ userId: user.id, name: 'YouTube processor test batch' })
      .returning();
    if (!batch) throw new Error('failed to insert test batch');

    const [item] = await db
      .insert(postItems)
      .values({
        batchId: batch.id,
        mediaAssetId: media.id,
        defaultCaption: 'YouTube processor test caption',
        defaultTitle: 'YouTube processor test title',
      })
      .returning();
    if (!item) throw new Error('failed to insert test post item');

    const [postTarget] = await db
      .insert(postTargets)
      .values({ postItemId: item.id, publishTargetId: target.id, status: 'pending' })
      .returning();
    if (!postTarget) throw new Error('failed to insert test post target');

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = input.toString();

      if (urlStr === 'https://oauth2.googleapis.com/token') {
        const params = init?.body as URLSearchParams;
        expect(params.get('grant_type')).toBe('refresh_token');
        expect(params.get('refresh_token')).toBe('google-refresh-token');
        return jsonResponse({ access_token: 'fresh-access-token', expires_in: 3600 });
      }

      if (urlStr.includes('uploadType=resumable')) {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer fresh-access-token');
        const body = JSON.parse(init?.body as string);
        expect(body.snippet.title).toBe('YouTube processor test title');
        expect(body.snippet.description).toBe('YouTube processor test caption');
        return new Response(null, { status: 200, headers: { Location: UPLOAD_SESSION_URL } });
      }

      if (urlStr === UPLOAD_SESSION_URL) {
        return jsonResponse({ id: 'processor-test-yt-video-id' });
      }

      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = {
      data: { postTargetId: postTarget.id } as PublishToTargetJobData,
    } as Job<PublishToTargetJobData>;
    await processPublishToTarget(job);

    const [updated] = await db.select().from(postTargets).where(eq(postTargets.id, postTarget.id));
    expect(updated?.status).toBe('published');
    expect(updated?.platformPostId).toBe('processor-test-yt-video-id');
    expect(updated?.publishedAt).not.toBeNull();
    expect(updated?.lastError).toBeNull();
  });

  it('marks the post_target failed when the connection is missing a refresh token', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}yt-norefresh-${Date.now()}@example.com`;
    const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
    if (!user) throw new Error('failed to insert test user');

    const encryptedAccessToken = encrypt('google-access-token');
    const [connection] = await db
      .insert(platformConnections)
      .values({
        userId: user.id,
        platform: 'google',
        externalAccountId: 'me',
        displayName: 'Google',
        accessTokenCiphertext: encryptedAccessToken.ciphertext,
        accessTokenIv: encryptedAccessToken.iv,
        accessTokenTag: encryptedAccessToken.tag,
        // deliberately no refresh token
      })
      .returning();
    if (!connection) throw new Error('failed to insert test connection');

    const [target] = await db
      .insert(publishTargets)
      .values({
        userId: user.id,
        platformConnectionId: connection.id,
        platform: 'youtube_channel',
        externalId: 'channel-norefresh-test',
        displayName: 'No Refresh Test Channel',
        tokenSource: 'oauth',
      })
      .returning();
    if (!target) throw new Error('failed to insert test target');

    const storageKey = `${user.id}/processor-norefresh-yt.mp4`;
    const videoBytes = Buffer.from('fake-video-bytes-for-norefresh-test');
    await createStorageAdapterFromEnv().save(storageKey, videoBytes, 'video/mp4');

    const [media] = await db
      .insert(mediaAssets)
      .values({
        userId: user.id,
        originalFilename: 'clip.mp4',
        storageKey,
        fileSizeBytes: videoBytes.length,
      })
      .returning();
    if (!media) throw new Error('failed to insert test media asset');

    const [batch] = await db
      .insert(postBatches)
      .values({ userId: user.id, name: 'No refresh test batch' })
      .returning();
    if (!batch) throw new Error('failed to insert test batch');

    const [item] = await db
      .insert(postItems)
      .values({ batchId: batch.id, mediaAssetId: media.id, defaultCaption: 'No refresh caption' })
      .returning();
    if (!item) throw new Error('failed to insert test post item');

    const [postTarget] = await db
      .insert(postTargets)
      .values({ postItemId: item.id, publishTargetId: target.id, status: 'pending' })
      .returning();
    if (!postTarget) throw new Error('failed to insert test post target');

    const job = {
      data: { postTargetId: postTarget.id } as PublishToTargetJobData,
    } as Job<PublishToTargetJobData>;
    await expect(processPublishToTarget(job)).rejects.toThrow(/missing a refresh token/);

    const [updated] = await db.select().from(postTargets).where(eq(postTargets.id, postTarget.id));
    expect(updated?.status).toBe('failed');
  });
});

describe.skipIf(!ready || !redisReachable)('processPublishToTarget (YouTube quota backoff)', () => {
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('backs off a quota-exceeded upload as a delayed job instead of marking it permanently failed', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}yt-quota-${Date.now()}@example.com`;
    const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
    if (!user) throw new Error('failed to insert test user');

    const encryptedAccessToken = encrypt('google-access-token');
    const encryptedRefreshToken = encrypt('google-refresh-token');
    const [connection] = await db
      .insert(platformConnections)
      .values({
        userId: user.id,
        platform: 'google',
        externalAccountId: 'me',
        displayName: 'Google',
        accessTokenCiphertext: encryptedAccessToken.ciphertext,
        accessTokenIv: encryptedAccessToken.iv,
        accessTokenTag: encryptedAccessToken.tag,
        refreshTokenCiphertext: encryptedRefreshToken.ciphertext,
        refreshTokenIv: encryptedRefreshToken.iv,
        refreshTokenTag: encryptedRefreshToken.tag,
      })
      .returning();
    if (!connection) throw new Error('failed to insert test connection');

    const [target] = await db
      .insert(publishTargets)
      .values({
        userId: user.id,
        platformConnectionId: connection.id,
        platform: 'youtube_channel',
        externalId: `channel-quota-${Date.now()}`,
        displayName: 'Quota Test Channel',
        tokenSource: 'oauth',
      })
      .returning();
    if (!target) throw new Error('failed to insert test target');

    const storageKey = `${user.id}/processor-quota-test.mp4`;
    const videoBytes = Buffer.from('fake-video-bytes-for-quota-test');
    await createStorageAdapterFromEnv().save(storageKey, videoBytes, 'video/mp4');

    const [media] = await db
      .insert(mediaAssets)
      .values({
        userId: user.id,
        originalFilename: 'clip.mp4',
        storageKey,
        fileSizeBytes: videoBytes.length,
      })
      .returning();
    if (!media) throw new Error('failed to insert test media asset');

    const [batch] = await db
      .insert(postBatches)
      .values({ userId: user.id, name: 'Quota test batch' })
      .returning();
    if (!batch) throw new Error('failed to insert test batch');

    const [item] = await db
      .insert(postItems)
      .values({ batchId: batch.id, mediaAssetId: media.id, defaultCaption: 'Quota test caption' })
      .returning();
    if (!item) throw new Error('failed to insert test post item');

    const [postTarget] = await db
      .insert(postTargets)
      .values({
        postItemId: item.id,
        publishTargetId: target.id,
        status: 'pending',
        attemptCount: 2,
      })
      .returning();
    if (!postTarget) throw new Error('failed to insert test post target');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const urlStr = input.toString();
        if (urlStr === 'https://oauth2.googleapis.com/token') {
          return jsonResponse({ access_token: 'fresh-access-token', expires_in: 3600 });
        }
        if (urlStr.includes('uploadType=resumable')) {
          return jsonResponse(
            {
              error: {
                errors: [
                  { reason: 'quotaExceeded', message: 'The user has exceeded their quota.' },
                ],
              },
            },
            403,
          );
        }
        throw new Error(`Unexpected fetch call: ${urlStr}`);
      }),
    );

    // Runs through a real Queue+Worker (not a bare job object) — moveToDelayed
    // needs a genuinely active job holding BullMQ's lock token, which only a
    // live Worker invocation provides.
    const queueName = publishToTargetQueueName('youtube_channel', target.externalId);
    const queue = getQueue<PublishToTargetJobData>(queueName);
    const worker = getOrCreateWorker<PublishToTargetJobData>(queueName, (job, token) =>
      processPublishToTarget(job, token),
    );

    try {
      await queue.add(
        'publish',
        { postTargetId: postTarget.id },
        { jobId: postTarget.id, attempts: 5 },
      );

      await vi.waitFor(
        async () => {
          const job = await queue.getJob(postTarget.id);
          expect(await job?.getState()).toBe('delayed');
        },
        { timeout: 5000 },
      );

      const delayedJob = await queue.getJob(postTarget.id);
      expect(delayedJob?.attemptsMade).toBe(0);

      const [updated] = await db
        .select()
        .from(postTargets)
        .where(eq(postTargets.id, postTarget.id));
      expect(updated?.status).toBe('queued');
      expect(updated?.lastError).toMatch(/quota/i);
      // Not incremented — a quota block isn't a failed attempt at this item.
      expect(updated?.attemptCount).toBe(2);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
    }
  }, 10000);
});

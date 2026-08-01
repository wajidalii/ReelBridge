import 'dotenv/config';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { PublishToTargetJobData } from '@reelbridge/shared';
import {
  createStorageAdapterFromEnv,
  encrypt,
  getDb,
  getPool,
  mediaAssets,
  platformConnections,
  postBatches,
  postItems,
  postTargets,
  publishTargets,
  users,
} from '@reelbridge/shared';
import { eq, inArray, like } from 'drizzle-orm';
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

const [dbReachable, storageReachable] = await Promise.all([
  isDatabaseReachable(),
  isStorageReachable(),
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
    await getPool().end();
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

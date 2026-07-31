import 'dotenv/config';
import type { PollStatusJobData } from '@reelbridge/shared';
import {
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
import { processPollStatus } from './pollStatus.js';

process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';

const TEST_EMAIL_PREFIX = 'reelbridge-poll-status-test+';

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

const dbReachable = await isDatabaseReachable();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function createNativeScheduledPostTarget(email: string, platformPostId: string) {
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

  const encryptedToken = encrypt('real-page-access-token');
  const [target] = await db
    .insert(publishTargets)
    .values({
      userId: user.id,
      platformConnectionId: connection.id,
      platform: 'facebook_page',
      externalId: `page-${email}`,
      displayName: 'Poll Status Test Page',
      accessTokenCiphertext: encryptedToken.ciphertext,
      accessTokenIv: encryptedToken.iv,
      accessTokenTag: encryptedToken.tag,
    })
    .returning();
  if (!target) throw new Error('failed to insert test target');

  const [batch] = await db
    .insert(postBatches)
    .values({ userId: user.id, name: 'Poll status test batch' })
    .returning();
  if (!batch) throw new Error('failed to insert test batch');

  // Media asset is unused by poll-status (no upload happens here), but
  // post_items.media_asset_id is NOT NULL, so a row must exist to satisfy the FK.
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
    .values({
      batchId: batch.id,
      mediaAssetId: media.id,
      defaultCaption: 'Poll status test caption',
    })
    .returning();
  if (!item) throw new Error('failed to insert test post item');

  const [postTarget] = await db
    .insert(postTargets)
    .values({
      postItemId: item.id,
      publishTargetId: target.id,
      status: 'native_scheduled',
      platformPostId,
    })
    .returning();
  if (!postTarget) throw new Error('failed to insert test post target');

  return { user, target, postTarget };
}

describe.skipIf(!dbReachable)('processPollStatus (Facebook)', () => {
  afterAll(async () => {
    // post_items.media_asset_id is ON DELETE RESTRICT, so a plain `delete
    // from users` cascade fails once it reaches media_assets while post_items
    // still reference them — delete in dependency order instead.
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

  it('flips a published video to status=published and backfills the permalink', async () => {
    const { postTarget } = await createNativeScheduledPostTarget(
      `${TEST_EMAIL_PREFIX}published-${Date.now()}@example.com`,
      'fb-video-published-1',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: { video_status: 'published' },
          permalink_url: 'https://facebook.com/watch/?v=fb-video-published-1',
        }),
      ),
    );

    const job = {
      data: { postTargetId: postTarget.id } as PollStatusJobData,
    } as Job<PollStatusJobData>;
    await processPollStatus(job);

    const db = getDb();
    const [updated] = await db.select().from(postTargets).where(eq(postTargets.id, postTarget.id));
    expect(updated?.status).toBe('published');
    expect(updated?.permalinkUrl).toBe('https://facebook.com/watch/?v=fb-video-published-1');
    expect(updated?.publishedAt).not.toBeNull();
  });

  it('flips an errored video to status=failed with last_error set', async () => {
    const { postTarget } = await createNativeScheduledPostTarget(
      `${TEST_EMAIL_PREFIX}failed-${Date.now()}@example.com`,
      'fb-video-failed-1',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: { video_status: 'error' } })),
    );

    const job = {
      data: { postTargetId: postTarget.id } as PollStatusJobData,
    } as Job<PollStatusJobData>;
    await processPollStatus(job);

    const db = getDb();
    const [updated] = await db.select().from(postTargets).where(eq(postTargets.id, postTarget.id));
    expect(updated?.status).toBe('failed');
    expect(updated?.lastError).toBeDefined();
  });

  it('is a no-op for a post_target that is no longer native_scheduled', async () => {
    const { postTarget } = await createNativeScheduledPostTarget(
      `${TEST_EMAIL_PREFIX}noop-${Date.now()}@example.com`,
      'fb-video-noop-1',
    );
    const db = getDb();
    await db
      .update(postTargets)
      .set({ status: 'published' })
      .where(eq(postTargets.id, postTarget.id));

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const job = {
      data: { postTargetId: postTarget.id } as PollStatusJobData,
    } as Job<PollStatusJobData>;
    await processPollStatus(job);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

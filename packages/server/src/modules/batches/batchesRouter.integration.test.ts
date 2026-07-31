import 'dotenv/config';
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
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { signAccessToken } from '../auth/jwt.js';

process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';
process.env.JWT_SECRET ||= 'test-jwt-secret-for-integration-tests-only';

const TEST_EMAIL_PREFIX = 'reelbridge-batches-test+';

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

async function createUserWithMediaAndTarget(
  email: string,
  platform: 'facebook_page' | 'youtube_channel' = 'facebook_page',
) {
  const db = getDb();
  const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
  if (!user) throw new Error('failed to insert test user');

  const [media] = await db
    .insert(mediaAssets)
    .values({
      userId: user.id,
      originalFilename: 'clip.mp4',
      storageKey: `${user.id}/clip.mp4`,
      fileSizeBytes: 1000,
    })
    .returning();
  if (!media) throw new Error('failed to insert test media asset');

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
      platform,
      externalId: `target-${email}`,
      displayName: 'Test Target',
      accessTokenCiphertext: encryptedToken.ciphertext,
      accessTokenIv: encryptedToken.iv,
      accessTokenTag: encryptedToken.tag,
    })
    .returning();
  if (!target) throw new Error('failed to insert test target');

  return { user, media, target };
}

describe.skipIf(!dbReachable)('batches API', () => {
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

  it('creates a batch, attaches an item, and assigns a target with default caption fallback', async () => {
    const { user, media, target } = await createUserWithMediaAndTarget(
      `${TEST_EMAIL_PREFIX}${Date.now()}@example.com`,
    );
    const cookie = `reelbridge_access_token=${signAccessToken(user.id)}`;

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', cookie)
      .send({ name: 'My batch' });
    expect(batchRes.status).toBe(201);
    expect(batchRes.body.status).toBe('draft');
    const batchId = batchRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', cookie)
      .send({ media_asset_id: media.id, default_caption: 'Default caption' });
    expect(itemRes.status).toBe(201);
    const itemId = itemRes.body.id as string;

    const targetRes = await request(app)
      .post(`/api/batches/${batchId}/items/${itemId}/targets`)
      .set('Cookie', cookie)
      .send({ targets: [{ publish_target_id: target.id }] });
    expect(targetRes.status).toBe(201);
    expect(targetRes.body.created).toHaveLength(1);

    const getRes = await request(app).get(`/api/batches/${batchId}`).set('Cookie', cookie);
    expect(getRes.status).toBe(200);
    expect(getRes.body.items).toHaveLength(1);
    expect(getRes.body.items[0].targets).toHaveLength(1);
    expect(getRes.body.items[0].targets[0].captionOverride).toBeNull();

    const db = getDb();
    const [row] = await db
      .select()
      .from(postTargets)
      .where(eq(postTargets.id, targetRes.body.created[0].id));
    expect(row?.status).toBe('pending');
  });

  it('rejects attaching a media asset that belongs to another user', async () => {
    const { user: owner } = await createUserWithMediaAndTarget(
      `${TEST_EMAIL_PREFIX}owner-${Date.now()}@example.com`,
    );
    const { media: otherUsersMedia } = await createUserWithMediaAndTarget(
      `${TEST_EMAIL_PREFIX}other-${Date.now()}@example.com`,
    );
    const ownerCookie = `reelbridge_access_token=${signAccessToken(owner.id)}`;

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', ownerCookie)
      .send({ name: 'Owner batch' });
    const batchId = batchRes.body.id as string;

    const res = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', ownerCookie)
      .send({ media_asset_id: otherUsersMedia.id, default_caption: 'x' });

    expect(res.status).toBe(404);
  });

  it('rejects assigning a target the user does not own, without failing other assignments', async () => {
    const { user, media, target } = await createUserWithMediaAndTarget(
      `${TEST_EMAIL_PREFIX}multi-${Date.now()}@example.com`,
    );
    const { target: otherTarget } = await createUserWithMediaAndTarget(
      `${TEST_EMAIL_PREFIX}other-${Date.now()}@example.com`,
    );
    const cookie = `reelbridge_access_token=${signAccessToken(user.id)}`;

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', cookie)
      .send({ name: 'Multi target batch' });
    const batchId = batchRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', cookie)
      .send({ media_asset_id: media.id, default_caption: 'caption' });
    const itemId = itemRes.body.id as string;

    const res = await request(app)
      .post(`/api/batches/${batchId}/items/${itemId}/targets`)
      .set('Cookie', cookie)
      .send({
        targets: [{ publish_target_id: target.id }, { publish_target_id: otherTarget.id }],
      });

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0].publish_target_id).toBe(otherTarget.id);
  });

  it('rejects a caption exceeding the platform limit for that target', async () => {
    const { user, media, target } = await createUserWithMediaAndTarget(
      `${TEST_EMAIL_PREFIX}caption-${Date.now()}@example.com`,
      'youtube_channel',
    );
    const cookie = `reelbridge_access_token=${signAccessToken(user.id)}`;

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', cookie)
      .send({ name: 'Caption test batch' });
    const batchId = batchRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', cookie)
      .send({ media_asset_id: media.id, default_caption: 'short caption' });
    const itemId = itemRes.body.id as string;

    const res = await request(app)
      .post(`/api/batches/${batchId}/items/${itemId}/targets`)
      .set('Cookie', cookie)
      .send({
        targets: [
          {
            publish_target_id: target.id,
            title_override: 'x'.repeat(101),
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.rejected[0].error).toMatch(/title/i);
  });

  it('is 404 for a batch belonging to another user', async () => {
    const { user: owner } = await createUserWithMediaAndTarget(
      `${TEST_EMAIL_PREFIX}priv-owner-${Date.now()}@example.com`,
    );
    const { user: other } = await createUserWithMediaAndTarget(
      `${TEST_EMAIL_PREFIX}priv-other-${Date.now()}@example.com`,
    );
    const ownerCookie = `reelbridge_access_token=${signAccessToken(owner.id)}`;
    const otherCookie = `reelbridge_access_token=${signAccessToken(other.id)}`;

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', ownerCookie)
      .send({ name: 'Private batch' });
    const batchId = batchRes.body.id as string;

    const res = await request(app).get(`/api/batches/${batchId}`).set('Cookie', otherCookie);
    expect(res.status).toBe(404);
  });

  it('DELETE /:id/items/:itemId removes the item and unblocks deleting its media asset', async () => {
    const { user, media } = await createUserWithMediaAndTarget(
      `${TEST_EMAIL_PREFIX}delete-item-${Date.now()}@example.com`,
    );
    const cookie = `reelbridge_access_token=${signAccessToken(user.id)}`;

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', cookie)
      .send({ name: 'Delete-item batch' });
    const batchId = batchRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', cookie)
      .send({ media_asset_id: media.id, default_caption: 'caption' });
    const itemId = itemRes.body.id as string;

    const db = getDb();
    // The FK from post_items to media_assets is ON DELETE RESTRICT, so this
    // must fail while the item still exists — proving the delete-item route
    // below is actually necessary, not redundant with deleting the media
    // directly. Checked at the DB layer (not via DELETE /api/media/:id) so
    // this test doesn't depend on storage being configured, unlike the media
    // module's own tests.
    await expect(db.delete(mediaAssets).where(eq(mediaAssets.id, media.id))).rejects.toThrow();

    const deleteRes = await request(app)
      .delete(`/api/batches/${batchId}/items/${itemId}`)
      .set('Cookie', cookie);
    expect(deleteRes.status).toBe(204);

    const [row] = await db.select().from(postItems).where(eq(postItems.id, itemId));
    expect(row).toBeUndefined();

    await expect(
      db.delete(mediaAssets).where(eq(mediaAssets.id, media.id)),
    ).resolves.not.toThrow();
  });

  it('DELETE /:id/items/:itemId is 404 for another user\'s item', async () => {
    const { user: owner, media } = await createUserWithMediaAndTarget(
      `${TEST_EMAIL_PREFIX}delete-item-owner-${Date.now()}@example.com`,
    );
    const { user: other } = await createUserWithMediaAndTarget(
      `${TEST_EMAIL_PREFIX}delete-item-other-${Date.now()}@example.com`,
    );
    const ownerCookie = `reelbridge_access_token=${signAccessToken(owner.id)}`;
    const otherCookie = `reelbridge_access_token=${signAccessToken(other.id)}`;

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', ownerCookie)
      .send({ name: 'Owner-only batch' });
    const batchId = batchRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', ownerCookie)
      .send({ media_asset_id: media.id, default_caption: 'caption' });
    const itemId = itemRes.body.id as string;

    const res = await request(app)
      .delete(`/api/batches/${batchId}/items/${itemId}`)
      .set('Cookie', otherCookie);
    expect(res.status).toBe(404);
  });
});

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

const TEST_EMAIL_PREFIX = 'reelbridge-preview-test+';

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

describe.skipIf(!dbReachable)('GET /api/batches/:id/preview', () => {
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

  it('resolves caption/title fallback, distinguishes native vs app-managed scheduling, and writes nothing', async () => {
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
      .send({ name: 'Preview batch' });
    const batchId = batchRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', cookie)
      .send({ media_asset_id: media.id, default_caption: 'Default caption' });
    const itemId = itemRes.body.id as string;

    await request(app)
      .post(`/api/batches/${batchId}/items/${itemId}/targets`)
      .set('Cookie', cookie)
      .send({
        targets: [
          { publish_target_id: fbTarget.id, caption_override: 'FB-specific caption' },
          { publish_target_id: igTarget.id },
        ],
      });

    const preview = await request(app).get(`/api/batches/${batchId}/preview`).set('Cookie', cookie);
    expect(preview.status).toBe(200);
    expect(preview.body.rows).toHaveLength(2);

    const fbRow = preview.body.rows.find(
      (r: { platform: string }) => r.platform === 'facebook_page',
    );
    const igRow = preview.body.rows.find(
      (r: { platform: string }) => r.platform === 'instagram_business',
    );

    expect(fbRow.resolvedCaption).toBe('FB-specific caption');
    expect(fbRow.schedulingMode).toBe('native_scheduled');
    expect(fbRow.blocking).toBe(false);

    expect(igRow.resolvedCaption).toBe('Default caption');
    expect(igRow.schedulingMode).toBe('awaiting_app_managed_publish');
    expect(igRow.blocking).toBe(false);

    // Zero writes: post_targets rows are untouched, and calling again is idempotent.
    const targetsBefore = await db
      .select()
      .from(postTargets)
      .where(eq(postTargets.postItemId, itemId));
    const preview2 = await request(app)
      .get(`/api/batches/${batchId}/preview`)
      .set('Cookie', cookie);
    const targetsAfter = await db
      .select()
      .from(postTargets)
      .where(eq(postTargets.postItemId, itemId));

    // Postgres doesn't guarantee row order without ORDER BY, so sort before
    // comparing rather than asserting on array order.
    const byPublishTargetId = (a: { publishTargetId: string }, b: { publishTargetId: string }) =>
      a.publishTargetId.localeCompare(b.publishTargetId);
    expect([...preview2.body.rows].sort(byPublishTargetId)).toEqual(
      [...preview.body.rows].sort(byPublishTargetId),
    );
    expect([...targetsAfter].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...targetsBefore].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it('flags a blocking warning for an inactive (needs-reconnect) target', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}inactive-${Date.now()}@example.com`;
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
      .send({ name: 'Inactive target batch' });
    const batchId = batchRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', cookie)
      .send({ media_asset_id: media.id, default_caption: 'caption' });
    const itemId = itemRes.body.id as string;

    await request(app)
      .post(`/api/batches/${batchId}/items/${itemId}/targets`)
      .set('Cookie', cookie)
      .send({ targets: [{ publish_target_id: inactiveTarget.id }] });

    const preview = await request(app).get(`/api/batches/${batchId}/preview`).set('Cookie', cookie);
    expect(preview.status).toBe(200);
    expect(preview.body.rows[0].blocking).toBe(true);
    expect(
      preview.body.rows[0].warnings.some(
        (w: { code: string }) => w.code === 'target_needs_reconnect',
      ),
    ).toBe(true);
  });

  it('surfaces non-blocking media constraint warnings without blocking the row', async () => {
    const db = getDb();
    const email = `${TEST_EMAIL_PREFIX}warn-${Date.now()}@example.com`;
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

    const target = await createTarget(user.id, connection.id, 'facebook_page');

    const [media] = await db
      .insert(mediaAssets)
      .values({
        userId: user.id,
        originalFilename: 'landscape.mp4',
        storageKey: `${user.id}/landscape.mp4`,
        fileSizeBytes: 1000,
        durationSeconds: 30,
        width: 1920,
        height: 1080,
      })
      .returning();
    if (!media) throw new Error('failed to insert test media asset');

    const batchRes = await request(app)
      .post('/api/batches')
      .set('Cookie', cookie)
      .send({ name: 'Warning batch' });
    const batchId = batchRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/batches/${batchId}/items`)
      .set('Cookie', cookie)
      .send({ media_asset_id: media.id, default_caption: 'caption' });
    const itemId = itemRes.body.id as string;

    await request(app)
      .post(`/api/batches/${batchId}/items/${itemId}/targets`)
      .set('Cookie', cookie)
      .send({ targets: [{ publish_target_id: target.id }] });

    const preview = await request(app).get(`/api/batches/${batchId}/preview`).set('Cookie', cookie);
    expect(preview.body.rows[0].blocking).toBe(false);
    expect(
      preview.body.rows[0].warnings.some(
        (w: { code: string }) => w.code === 'non_vertical_aspect_ratio',
      ),
    ).toBe(true);
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
      .send({ name: 'Private preview batch' });
    const batchId = batchRes.body.id as string;

    const res = await request(app)
      .get(`/api/batches/${batchId}/preview`)
      .set('Cookie', otherCookie);
    expect(res.status).toBe(404);
  });
});

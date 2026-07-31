import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getDb,
  getPool,
  mediaAssets,
  platformConnections,
  postBatches,
  postItems,
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_VIDEO_PATH = path.join(__dirname, '__fixtures__', 'test-video.mp4');
const NOT_A_VIDEO_PATH = path.join(__dirname, '__fixtures__', 'not-a-video.txt');

const TEST_EMAIL_PREFIX = 'reelbridge-media-test+';

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

async function createTestUser(email: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
  if (!user) throw new Error('failed to insert test user');
  return user;
}

describe.skipIf(!dbReachable)('media upload API', () => {
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
        await db.delete(postItems).where(inArray(postItems.id, itemIds));
        await db.delete(postBatches).where(inArray(postBatches.id, batchIds));
      }
      await db.delete(mediaAssets).where(inArray(mediaAssets.userId, userIds));
      await db.delete(publishTargets).where(inArray(publishTargets.userId, userIds));
      await db.delete(platformConnections).where(inArray(platformConnections.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await getPool().end();
  });

  it('uploads multiple files, streams them to storage, and extracts duration/width/height', async () => {
    const user = await createTestUser(`${TEST_EMAIL_PREFIX}${Date.now()}@example.com`);
    const cookie = `reelbridge_access_token=${signAccessToken(user.id)}`;

    const res = await request(app)
      .post('/api/media')
      .set('Cookie', cookie)
      .attach('files', TEST_VIDEO_PATH)
      .attach('files', TEST_VIDEO_PATH);

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);
    expect(res.body.failed).toHaveLength(0);

    const created = res.body.created[0];
    expect(created.originalFilename).toBe('test-video.mp4');
    expect(created.durationSeconds).toBeGreaterThanOrEqual(1);
    expect(created.width).toBe(320);
    expect(created.height).toBe(240);

    const db = getDb();
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, created.id));
    expect(row).toBeDefined();
    expect(row?.userId).toBe(user.id);
    expect(row?.fileSizeBytes).toBeGreaterThan(0);
  });

  it('rejects a non-mp4 file per-file without failing the rest of the batch', async () => {
    const user = await createTestUser(`${TEST_EMAIL_PREFIX}mixed-${Date.now()}@example.com`);
    const cookie = `reelbridge_access_token=${signAccessToken(user.id)}`;

    const res = await request(app)
      .post('/api/media')
      .set('Cookie', cookie)
      .attach('files', TEST_VIDEO_PATH)
      .attach('files', NOT_A_VIDEO_PATH);

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].originalFilename).toBe('not-a-video.txt');
    expect(res.body.failed[0].error).toMatch(/mp4/i);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/media').attach('files', TEST_VIDEO_PATH);
    expect(res.status).toBe(401);
  });

  it('GET/DELETE are ownership-checked', async () => {
    const owner = await createTestUser(`${TEST_EMAIL_PREFIX}owner-${Date.now()}@example.com`);
    const other = await createTestUser(`${TEST_EMAIL_PREFIX}other-${Date.now()}@example.com`);
    const ownerCookie = `reelbridge_access_token=${signAccessToken(owner.id)}`;
    const otherCookie = `reelbridge_access_token=${signAccessToken(other.id)}`;

    const uploadRes = await request(app)
      .post('/api/media')
      .set('Cookie', ownerCookie)
      .attach('files', TEST_VIDEO_PATH);
    const mediaId = uploadRes.body.created[0].id as string;

    const getAsOwner = await request(app).get(`/api/media/${mediaId}`).set('Cookie', ownerCookie);
    expect(getAsOwner.status).toBe(200);

    const getAsOther = await request(app).get(`/api/media/${mediaId}`).set('Cookie', otherCookie);
    expect(getAsOther.status).toBe(404);

    const deleteAsOther = await request(app)
      .delete(`/api/media/${mediaId}`)
      .set('Cookie', otherCookie);
    expect(deleteAsOther.status).toBe(404);

    const deleteAsOwner = await request(app)
      .delete(`/api/media/${mediaId}`)
      .set('Cookie', ownerCookie);
    expect(deleteAsOwner.status).toBe(204);

    const db = getDb();
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId));
    expect(row).toBeUndefined();
  });

  it('returns 409 rather than crashing when deleting media referenced by a post item', async () => {
    const user = await createTestUser(`${TEST_EMAIL_PREFIX}restrict-${Date.now()}@example.com`);
    const cookie = `reelbridge_access_token=${signAccessToken(user.id)}`;

    const uploadRes = await request(app)
      .post('/api/media')
      .set('Cookie', cookie)
      .attach('files', TEST_VIDEO_PATH);
    const mediaId = uploadRes.body.created[0].id as string;

    const db = getDb();
    const [batch] = await db
      .insert(postBatches)
      .values({ userId: user.id, name: 'Restrict test batch' })
      .returning();
    if (!batch) throw new Error('failed to insert test batch');
    await db.insert(postItems).values({
      batchId: batch.id,
      mediaAssetId: mediaId,
      defaultCaption: 'test',
    });

    const res = await request(app).delete(`/api/media/${mediaId}`).set('Cookie', cookie);
    expect(res.status).toBe(409);

    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId));
    expect(row).toBeDefined();
  });
});

import 'dotenv/config';
import { like } from 'drizzle-orm';
import express from 'express';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { getDb, getPool } from '../../db/client.js';
import {
  mediaAssets,
  platformConnections,
  postBatches,
  postItems,
  postTargets,
  publishTargets,
  users,
} from '../../db/schema.js';
import {
  assertBatchOwnership,
  assertMediaAssetOwnership,
  assertPostItemOwnership,
  assertPostTargetOwnership,
  assertTargetOwnership,
  ResourceNotFoundError,
} from './assertOwnership.js';
import { ownershipErrorHandler, requireOwnership } from './middleware.js';

const TEST_EMAIL_PREFIX = 'reelbridge-ownership-integration-test+';

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

async function createResourceSetForUser(db: Database, email: string) {
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: 'unused-in-this-test' })
    .returning();
  if (!user) throw new Error('failed to insert test user');

  const [connection] = await db
    .insert(platformConnections)
    .values({
      userId: user.id,
      platform: 'facebook',
      externalAccountId: `ext-${email}`,
      displayName: 'Test Connection',
      accessTokenCiphertext: 'x',
      accessTokenIv: 'x',
      accessTokenTag: 'x',
    })
    .returning();
  if (!connection) throw new Error('failed to insert test connection');

  const [target] = await db
    .insert(publishTargets)
    .values({
      userId: user.id,
      platformConnectionId: connection.id,
      platform: 'facebook_page',
      externalId: `page-${email}`,
      displayName: 'Test Page',
    })
    .returning();
  if (!target) throw new Error('failed to insert test target');

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

  const [batch] = await db
    .insert(postBatches)
    .values({ userId: user.id, name: 'Test batch' })
    .returning();
  if (!batch) throw new Error('failed to insert test batch');

  const [item] = await db
    .insert(postItems)
    .values({ batchId: batch.id, mediaAssetId: media.id, defaultCaption: 'hello' })
    .returning();
  if (!item) throw new Error('failed to insert test post item');

  const [postTarget] = await db
    .insert(postTargets)
    .values({ postItemId: item.id, publishTargetId: target.id })
    .returning();
  if (!postTarget) throw new Error('failed to insert test post target');

  return { user, target, media, batch, item, postTarget };
}

describe.skipIf(!dbReachable)('multi-tenant isolation via assert*Ownership', () => {
  afterAll(async () => {
    await getDb()
      .delete(users)
      .where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
    await getPool().end();
  });

  it('confirms neither user can read or act on the other resource-set via the ownership boundary', async () => {
    const db = getDb();
    const a = await createResourceSetForUser(db, `${TEST_EMAIL_PREFIX}a-${Date.now()}@example.com`);
    const b = await createResourceSetForUser(db, `${TEST_EMAIL_PREFIX}b-${Date.now()}@example.com`);

    // Owner access resolves.
    await expect(assertTargetOwnership(a.user.id, a.target.id)).resolves.toBeUndefined();
    await expect(assertMediaAssetOwnership(a.user.id, a.media.id)).resolves.toBeUndefined();
    await expect(assertBatchOwnership(a.user.id, a.batch.id)).resolves.toBeUndefined();
    await expect(assertPostItemOwnership(a.user.id, a.item.id)).resolves.toBeUndefined();
    await expect(assertPostTargetOwnership(a.user.id, a.postTarget.id)).resolves.toBeUndefined();

    // Cross-tenant access rejects, symmetrically in both directions.
    await expect(assertTargetOwnership(b.user.id, a.target.id)).rejects.toThrow(
      ResourceNotFoundError,
    );
    await expect(assertMediaAssetOwnership(b.user.id, a.media.id)).rejects.toThrow(
      ResourceNotFoundError,
    );
    await expect(assertBatchOwnership(b.user.id, a.batch.id)).rejects.toThrow(
      ResourceNotFoundError,
    );
    await expect(assertPostItemOwnership(b.user.id, a.item.id)).rejects.toThrow(
      ResourceNotFoundError,
    );
    await expect(assertPostTargetOwnership(b.user.id, a.postTarget.id)).rejects.toThrow(
      ResourceNotFoundError,
    );

    await expect(assertTargetOwnership(a.user.id, b.target.id)).rejects.toThrow(
      ResourceNotFoundError,
    );
    await expect(assertMediaAssetOwnership(a.user.id, b.media.id)).rejects.toThrow(
      ResourceNotFoundError,
    );
    await expect(assertBatchOwnership(a.user.id, b.batch.id)).rejects.toThrow(
      ResourceNotFoundError,
    );
    await expect(assertPostItemOwnership(a.user.id, b.item.id)).rejects.toThrow(
      ResourceNotFoundError,
    );
    await expect(assertPostTargetOwnership(a.user.id, b.postTarget.id)).rejects.toThrow(
      ResourceNotFoundError,
    );
  });

  it('fails with 404 at the HTTP layer for cross-tenant access, indistinguishable from a nonexistent resource', async () => {
    const db = getDb();
    const a = await createResourceSetForUser(
      db,
      `${TEST_EMAIL_PREFIX}http-a-${Date.now()}@example.com`,
    );
    const b = await createResourceSetForUser(
      db,
      `${TEST_EMAIL_PREFIX}http-b-${Date.now()}@example.com`,
    );

    const testApp = express();
    testApp.use((req, _res, next) => {
      req.userId = req.header('x-test-user-id') ?? undefined;
      next();
    });
    testApp.get(
      '/targets/:targetId',
      requireOwnership('targetId', assertTargetOwnership),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    testApp.use(ownershipErrorHandler);

    const ownRes = await request(testApp)
      .get(`/targets/${a.target.id}`)
      .set('x-test-user-id', a.user.id);
    expect(ownRes.status).toBe(200);

    const otherOwnerRes = await request(testApp)
      .get(`/targets/${a.target.id}`)
      .set('x-test-user-id', b.user.id);
    expect(otherOwnerRes.status).toBe(404);

    const nonexistentRes = await request(testApp)
      .get('/targets/00000000-0000-0000-0000-000000000000')
      .set('x-test-user-id', a.user.id);
    expect(nonexistentRes.status).toBe(404);
    // Same status and body shape for "belongs to someone else" and "never existed" — no leak.
    expect(otherOwnerRes.body).toEqual(nonexistentRes.body);
  });
});

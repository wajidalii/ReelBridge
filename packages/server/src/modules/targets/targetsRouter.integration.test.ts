import 'dotenv/config';
import {
  encrypt,
  getDb,
  getPool,
  getQueue,
  HEALTH_CHECK_QUEUE_NAME,
  platformConnections,
  publishTargets,
  users,
} from '@reelbridge/shared';
import { inArray, like } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { signAccessToken } from '../auth/jwt.js';

process.env.JWT_SECRET ||= 'test-jwt-secret-for-integration-tests-only';
process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';

const TEST_EMAIL_PREFIX = 'reelbridge-targets-router-test+';

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

async function createUserWithTarget(email: string) {
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

  const encryptedToken = encrypt('token');
  const [target] = await db
    .insert(publishTargets)
    .values({
      userId: user.id,
      platformConnectionId: connection.id,
      platform: 'facebook_page',
      externalId: `page-${email}`,
      displayName: 'Revalidate Test Page',
      accessTokenCiphertext: encryptedToken.ciphertext,
      accessTokenIv: encryptedToken.iv,
      accessTokenTag: encryptedToken.tag,
    })
    .returning();
  if (!target) throw new Error('failed to insert test target');

  return { user, target };
}

describe.skipIf(!ready)('POST /api/targets/:id/revalidate', () => {
  const app = createApp();

  afterAll(async () => {
    const db = getDb();
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
    const userIds = testUsers.map((u) => u.id);
    if (userIds.length > 0) {
      await db.delete(publishTargets).where(inArray(publishTargets.userId, userIds));
      await db.delete(platformConnections).where(inArray(platformConnections.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await getPool().end();
  });

  it('enqueues a health-check job for the owner and returns 202', async () => {
    const { user, target } = await createUserWithTarget(
      `${TEST_EMAIL_PREFIX}owner-${Date.now()}@example.com`,
    );
    const cookie = `reelbridge_access_token=${signAccessToken(user.id)}`;

    const res = await request(app)
      .post(`/api/targets/${target.id}/revalidate`)
      .set('Cookie', cookie);

    expect(res.status).toBe(202);

    const queue = getQueue<{ publishTargetId: string }>(HEALTH_CHECK_QUEUE_NAME);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    const enqueuedIds = jobs.map((job) => job.data.publishTargetId);
    expect(enqueuedIds).toContain(target.id);

    await Promise.all(
      jobs.filter((job) => job.data.publishTargetId === target.id).map((job) => job.remove()),
    );
  });

  it("rejects revalidating another user's target with 404", async () => {
    const { target } = await createUserWithTarget(
      `${TEST_EMAIL_PREFIX}victim-${Date.now()}@example.com`,
    );
    const { user: attacker } = await createUserWithTarget(
      `${TEST_EMAIL_PREFIX}attacker-${Date.now()}@example.com`,
    );
    const attackerCookie = `reelbridge_access_token=${signAccessToken(attacker.id)}`;

    const res = await request(app)
      .post(`/api/targets/${target.id}/revalidate`)
      .set('Cookie', attackerCookie);

    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const { target } = await createUserWithTarget(
      `${TEST_EMAIL_PREFIX}noauth-${Date.now()}@example.com`,
    );
    const res = await request(app).post(`/api/targets/${target.id}/revalidate`);
    expect(res.status).toBe(401);
  });
});

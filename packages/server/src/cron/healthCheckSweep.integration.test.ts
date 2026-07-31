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
import { afterAll, describe, expect, it } from 'vitest';
import { enqueueDueHealthCheckJobs } from './healthCheckSweep.js';

const TEST_EMAIL_PREFIX = 'reelbridge-health-sweep-test+';

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
  email: string,
  options: { platform: 'facebook_page' | 'instagram_business'; isActive: boolean },
) {
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
      platform: options.platform,
      externalId: `page-${email}`,
      displayName: 'Sweep Test Target',
      accessTokenCiphertext: encryptedToken.ciphertext,
      accessTokenIv: encryptedToken.iv,
      accessTokenTag: encryptedToken.tag,
      isActive: options.isActive,
    })
    .returning();
  if (!target) throw new Error('failed to insert test target');

  return target;
}

describe.skipIf(!ready)('enqueueDueHealthCheckJobs', () => {
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

  it('enqueues only active facebook_page targets, not inactive or non-Facebook ones', async () => {
    const active = await createTarget(`${TEST_EMAIL_PREFIX}active-${Date.now()}@example.com`, {
      platform: 'facebook_page',
      isActive: true,
    });
    const inactive = await createTarget(`${TEST_EMAIL_PREFIX}inactive-${Date.now()}@example.com`, {
      platform: 'facebook_page',
      isActive: false,
    });
    const otherPlatform = await createTarget(
      `${TEST_EMAIL_PREFIX}other-${Date.now()}@example.com`,
      {
        platform: 'instagram_business',
        isActive: true,
      },
    );

    await enqueueDueHealthCheckJobs();

    const queue = getQueue<{ publishTargetId: string }>(HEALTH_CHECK_QUEUE_NAME);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    const enqueuedIds = jobs.map((job) => job.data.publishTargetId);

    expect(enqueuedIds).toContain(active.id);
    expect(enqueuedIds).not.toContain(inactive.id);
    expect(enqueuedIds).not.toContain(otherPlatform.id);

    const testTargetIds = new Set([active.id, inactive.id, otherPlatform.id]);
    await Promise.all(
      jobs.filter((job) => testTargetIds.has(job.data.publishTargetId)).map((job) => job.remove()),
    );
  });
});

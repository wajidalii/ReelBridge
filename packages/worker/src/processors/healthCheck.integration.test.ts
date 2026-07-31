import 'dotenv/config';
import type { HealthCheckJobData } from '@reelbridge/shared';
import {
  encrypt,
  getDb,
  getPool,
  platformConnections,
  publishTargets,
  users,
} from '@reelbridge/shared';
import { eq, inArray, like } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { processHealthCheck } from './healthCheck.js';

process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';

const TEST_EMAIL_PREFIX = 'reelbridge-health-check-test+';

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function createFacebookTarget(email: string) {
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

  const encryptedToken = encrypt('page-access-token');
  const [target] = await db
    .insert(publishTargets)
    .values({
      userId: user.id,
      platformConnectionId: connection.id,
      platform: 'facebook_page',
      externalId: `page-${email}`,
      displayName: 'Health Check Test Page',
      accessTokenCiphertext: encryptedToken.ciphertext,
      accessTokenIv: encryptedToken.iv,
      accessTokenTag: encryptedToken.tag,
      isActive: true,
    })
    .returning();
  if (!target) throw new Error('failed to insert test target');

  return { user, target };
}

describe.skipIf(!dbReachable)('processHealthCheck (Facebook)', () => {
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a target active when the token is still valid, and updates last_validated_at', async () => {
    const { target } = await createFacebookTarget(
      `${TEST_EMAIL_PREFIX}healthy-${Date.now()}@example.com`,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ id: target.externalId, name: 'Health Check Test Page' })),
    );

    const job = {
      data: { publishTargetId: target.id } as HealthCheckJobData,
    } as Job<HealthCheckJobData>;
    await processHealthCheck(job);

    const db = getDb();
    const [updated] = await db
      .select()
      .from(publishTargets)
      .where(eq(publishTargets.id, target.id));
    expect(updated?.isActive).toBe(true);
    expect(updated?.lastValidatedAt).not.toBeNull();
  });

  it('flips a target inactive when the token check fails, and still updates last_validated_at', async () => {
    const { target } = await createFacebookTarget(
      `${TEST_EMAIL_PREFIX}broken-${Date.now()}@example.com`,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'Invalid OAuth access token' } }, 400)),
    );

    const job = {
      data: { publishTargetId: target.id } as HealthCheckJobData,
    } as Job<HealthCheckJobData>;
    await processHealthCheck(job);

    const db = getDb();
    const [updated] = await db
      .select()
      .from(publishTargets)
      .where(eq(publishTargets.id, target.id));
    expect(updated?.isActive).toBe(false);
    expect(updated?.lastValidatedAt).not.toBeNull();
  });
});

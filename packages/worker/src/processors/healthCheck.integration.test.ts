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
import { and, eq, inArray, like } from 'drizzle-orm';
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

  it('re-discovers and upserts a newly linked Instagram Business account on re-check (issue #32)', async () => {
    const { user, target } = await createFacebookTarget(
      `${TEST_EMAIL_PREFIX}ig-newly-linked-${Date.now()}@example.com`,
    );

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('instagram_business_account')) {
        return jsonResponse({
          instagram_business_account: { id: 'ig-recheck-1', username: 'recheck_ig' },
        });
      }
      if (urlStr.includes('account_type')) {
        return jsonResponse({ account_type: 'BUSINESS' });
      }
      return jsonResponse({ id: target.externalId, name: 'Health Check Test Page' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = {
      data: { publishTargetId: target.id, trigger: 'manual' } as HealthCheckJobData,
    } as Job<HealthCheckJobData>;
    await processHealthCheck(job);

    const db = getDb();
    const [igTarget] = await db
      .select()
      .from(publishTargets)
      .where(
        and(eq(publishTargets.userId, user.id), eq(publishTargets.platform, 'instagram_business')),
      );
    expect(igTarget?.externalId).toBe('ig-recheck-1');
    expect(igTarget?.isActive).toBe(true);
  });

  it('does not re-run Instagram discovery on a sweep-triggered (non-manual) re-check', async () => {
    const { user, target } = await createFacebookTarget(
      `${TEST_EMAIL_PREFIX}ig-sweep-skip-${Date.now()}@example.com`,
    );

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('instagram_business_account') || urlStr.includes('account_type')) {
        throw new Error(`Instagram discovery must not run on a sweep trigger: ${urlStr}`);
      }
      return jsonResponse({ id: target.externalId, name: 'Health Check Test Page' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = {
      data: { publishTargetId: target.id, trigger: 'sweep' } as HealthCheckJobData,
    } as Job<HealthCheckJobData>;
    await processHealthCheck(job);

    const db = getDb();
    const igTargets = await db
      .select()
      .from(publishTargets)
      .where(
        and(eq(publishTargets.userId, user.id), eq(publishTargets.platform, 'instagram_business')),
      );
    expect(igTargets).toHaveLength(0);
  });

  it('deactivates a previously-linked Instagram target when it is downgraded to Personal on re-check', async () => {
    const { user, target } = await createFacebookTarget(
      `${TEST_EMAIL_PREFIX}ig-downgraded-${Date.now()}@example.com`,
    );
    const db = getDb();
    await db.insert(publishTargets).values({
      userId: user.id,
      platformConnectionId: target.platformConnectionId,
      platform: 'instagram_business',
      externalId: 'ig-recheck-2',
      displayName: 'recheck_ig_2',
      tokenSource: 'oauth',
      metadata: { linkedFacebookPageId: target.externalId, username: 'recheck_ig_2' },
      isActive: true,
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('instagram_business_account')) {
        return jsonResponse({
          instagram_business_account: { id: 'ig-recheck-2', username: 'recheck_ig_2' },
        });
      }
      if (urlStr.includes('account_type')) {
        return jsonResponse({ account_type: 'PERSONAL' });
      }
      return jsonResponse({ id: target.externalId, name: 'Health Check Test Page' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = {
      data: { publishTargetId: target.id, trigger: 'manual' } as HealthCheckJobData,
    } as Job<HealthCheckJobData>;
    await processHealthCheck(job);

    const [igTarget] = await db
      .select()
      .from(publishTargets)
      .where(
        and(
          eq(publishTargets.userId, user.id),
          eq(publishTargets.platform, 'instagram_business'),
          eq(publishTargets.externalId, 'ig-recheck-2'),
        ),
      );
    expect(igTarget?.isActive).toBe(false);
  });

  it('deactivates a previously-linked Instagram target when the Page becomes fully unlinked on re-check', async () => {
    const { user, target } = await createFacebookTarget(
      `${TEST_EMAIL_PREFIX}ig-fully-unlinked-${Date.now()}@example.com`,
    );
    const db = getDb();
    await db.insert(publishTargets).values({
      userId: user.id,
      platformConnectionId: target.platformConnectionId,
      platform: 'instagram_business',
      externalId: 'ig-recheck-3',
      displayName: 'recheck_ig_3',
      tokenSource: 'oauth',
      metadata: { linkedFacebookPageId: target.externalId, username: 'recheck_ig_3' },
      isActive: true,
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('instagram_business_account')) {
        return jsonResponse({});
      }
      return jsonResponse({ id: target.externalId, name: 'Health Check Test Page' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = {
      data: { publishTargetId: target.id, trigger: 'manual' } as HealthCheckJobData,
    } as Job<HealthCheckJobData>;
    await processHealthCheck(job);

    const [igTarget] = await db
      .select()
      .from(publishTargets)
      .where(
        and(
          eq(publishTargets.userId, user.id),
          eq(publishTargets.platform, 'instagram_business'),
          eq(publishTargets.externalId, 'ig-recheck-3'),
        ),
      );
    expect(igTarget?.isActive).toBe(false);
  });
});

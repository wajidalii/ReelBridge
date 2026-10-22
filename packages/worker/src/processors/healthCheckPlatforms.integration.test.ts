import 'dotenv/config';
import {
  encrypt,
  getDb,
  getPool,
  platformConnections,
  publishTargets,
  users,
  type HealthCheckJobData,
} from '@reelbridge/shared';
import type { Job } from 'bullmq';
import { eq, inArray, like } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { processHealthCheck } from './healthCheck.js';

process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';
process.env.GOOGLE_CLIENT_ID ||= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ||= 'test-client-secret';
const TEST_EMAIL_PREFIX = 'reelbridge-health-platforms-test+';

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

async function seedInstagram(email: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
  const [conn] = await db
    .insert(platformConnections)
    .values({
      userId: user!.id,
      platform: 'facebook',
      externalAccountId: 'me',
      displayName: 'FB',
      accessTokenCiphertext: 'x',
      accessTokenIv: 'x',
      accessTokenTag: 'x',
    })
    .returning();
  const tok = encrypt('page-token');
  await db.insert(publishTargets).values({
    userId: user!.id,
    platformConnectionId: conn!.id,
    platform: 'facebook_page',
    externalId: `page-${email}`,
    displayName: 'Page',
    accessTokenCiphertext: tok.ciphertext,
    accessTokenIv: tok.iv,
    accessTokenTag: tok.tag,
  });
  const [ig] = await db
    .insert(publishTargets)
    .values({
      userId: user!.id,
      platformConnectionId: conn!.id,
      platform: 'instagram_business',
      externalId: `ig-${email}`,
      displayName: 'IG',
      metadata: { linkedFacebookPageId: `page-${email}` },
    })
    .returning();
  return ig!;
}

async function seedYouTube(email: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({ email, passwordHash: 'unused' }).returning();
  const refresh = encrypt('refresh-token');
  const [conn] = await db
    .insert(platformConnections)
    .values({
      userId: user!.id,
      platform: 'google',
      externalAccountId: 'me',
      displayName: 'Google',
      accessTokenCiphertext: 'x',
      accessTokenIv: 'x',
      accessTokenTag: 'x',
      refreshTokenCiphertext: refresh.ciphertext,
      refreshTokenIv: refresh.iv,
      refreshTokenTag: refresh.tag,
    })
    .returning();
  const [yt] = await db
    .insert(publishTargets)
    .values({
      userId: user!.id,
      platformConnectionId: conn!.id,
      platform: 'youtube_channel',
      externalId: `yt-${email}`,
      displayName: 'Ch',
    })
    .returning();
  return { yt: yt!, conn: conn! };
}

describe.skipIf(!dbReachable)('processHealthCheck for Instagram and YouTube (issue #36)', () => {
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    const db = getDb();
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
    const ids = testUsers.map((u) => u.id);
    if (ids.length > 0) {
      await db.delete(publishTargets).where(inArray(publishTargets.userId, ids));
      await db.delete(platformConnections).where(inArray(platformConnections.userId, ids));
      await db.delete(users).where(inArray(users.id, ids));
    }
    await getPool().end();
  });

  it('instagram: healthy when the linked Page token can read a Business account', async () => {
    const ig = await seedInstagram(`${TEST_EMAIL_PREFIX}ig-ok-${Date.now()}@example.com`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = input.toString();
        expect(url).toContain(`/${ig.externalId}?`);
        expect(url).toContain('access_token=page-token');
        return jsonResponse({ id: ig.externalId, username: 'brand', account_type: 'BUSINESS' });
      }),
    );
    await processHealthCheck({
      data: { publishTargetId: ig.id, trigger: 'sweep' },
    } as Job<HealthCheckJobData>);
    const [row] = await getDb().select().from(publishTargets).where(eq(publishTargets.id, ig.id));
    expect(row?.isActive).toBe(true);
    expect(row?.lastValidatedAt).not.toBeNull();
    expect((row?.metadata as Record<string, unknown>).lastHealthError).toBeUndefined();
  });

  it('instagram: flagged needs-reconnect with a reason when downgraded to Personal', async () => {
    const ig = await seedInstagram(`${TEST_EMAIL_PREFIX}ig-personal-${Date.now()}@example.com`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ id: ig.externalId, account_type: 'PERSONAL' })),
    );
    await processHealthCheck({
      data: { publishTargetId: ig.id, trigger: 'sweep' },
    } as Job<HealthCheckJobData>);
    const [row] = await getDb().select().from(publishTargets).where(eq(publishTargets.id, ig.id));
    expect(row?.isActive).toBe(false);
    expect((row?.metadata as Record<string, unknown>).lastHealthError).toMatch(/Personal/);
  });

  it('youtube: invalid_grant marks the connection revoked and every channel under it inactive', async () => {
    const { yt, conn } = await seedYouTube(
      `${TEST_EMAIL_PREFIX}yt-revoked-${Date.now()}@example.com`,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'invalid_grant', error_description: 'Token has been revoked.' }, 400),
      ),
    );
    await processHealthCheck({
      data: { publishTargetId: yt.id, trigger: 'sweep' },
    } as Job<HealthCheckJobData>);
    const [row] = await getDb().select().from(publishTargets).where(eq(publishTargets.id, yt.id));
    expect(row?.isActive).toBe(false);
    const [c] = await getDb()
      .select()
      .from(platformConnections)
      .where(eq(platformConnections.id, conn.id));
    expect(c?.status).toBe('revoked');
  });

  it('youtube: a transient 5xx leaves is_active untouched (inconclusive, not dead)', async () => {
    const { yt } = await seedYouTube(`${TEST_EMAIL_PREFIX}yt-5xx-${Date.now()}@example.com`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'backend' }, 503)),
    );
    await processHealthCheck({
      data: { publishTargetId: yt.id, trigger: 'sweep' },
    } as Job<HealthCheckJobData>);
    const [row] = await getDb().select().from(publishTargets).where(eq(publishTargets.id, yt.id));
    expect(row?.isActive).toBe(true);
    expect(row?.lastValidatedAt).not.toBeNull();
  });

  it('youtube: a working refresh token is healthy', async () => {
    const { yt } = await seedYouTube(`${TEST_EMAIL_PREFIX}yt-ok-${Date.now()}@example.com`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ access_token: 'fresh', expires_in: 3600 })),
    );
    await processHealthCheck({
      data: { publishTargetId: yt.id, trigger: 'sweep' },
    } as Job<HealthCheckJobData>);
    const [row] = await getDb().select().from(publishTargets).where(eq(publishTargets.id, yt.id));
    expect(row?.isActive).toBe(true);
  });
});

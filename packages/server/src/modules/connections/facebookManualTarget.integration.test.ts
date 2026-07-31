import 'dotenv/config';
import { and, eq, like } from 'drizzle-orm';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb, getPool, publishTargets, users } from '@reelbridge/shared';
import { createApp } from '../../app.js';
import { signAccessToken } from '../auth/jwt.js';

// `||=` rather than `??=`: a real .env commonly has these as empty-string
// placeholders before secrets are filled in, which `??=` would not override.
process.env.JWT_SECRET ||= 'test-jwt-secret-for-integration-tests-only';
process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';

const TEST_EMAIL_PREFIX = 'reelbridge-facebook-manual-test+';

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

describe.skipIf(!dbReachable)('POST /api/targets/facebook/manual', () => {
  const app = createApp();
  let userId: string;
  let accessTokenCookie: string;

  beforeAll(async () => {
    const [user] = await getDb()
      .insert(users)
      .values({ email: `${TEST_EMAIL_PREFIX}${Date.now()}@example.com`, passwordHash: 'unused' })
      .returning();
    if (!user) throw new Error('failed to insert test user');
    userId = user.id;
    accessTokenCookie = `reelbridge_access_token=${signAccessToken(userId)}`;
  });

  afterAll(async () => {
    await getDb()
      .delete(users)
      .where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
    await getPool().end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('validates the token via a live Graph API call, stores it encrypted with token_source=manual', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('graph.facebook.com/v21.0/manual-page-1')) {
        return jsonResponse({ id: 'manual-page-1', name: 'Manually Added Page' });
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(app)
      .post('/api/targets/facebook/manual')
      .set('Cookie', accessTokenCookie)
      .send({ page_id: 'manual-page-1', name: 'My Page', access_token: 'raw-manual-token' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      externalId: 'manual-page-1',
      displayName: 'Manually Added Page',
    });

    const [target] = await getDb()
      .select()
      .from(publishTargets)
      .where(
        and(
          eq(publishTargets.userId, userId),
          eq(publishTargets.platform, 'facebook_page'),
          eq(publishTargets.externalId, 'manual-page-1'),
        ),
      );
    expect(target).toBeDefined();
    expect(target?.tokenSource).toBe('manual');
    expect(target?.accessTokenCiphertext).not.toBe('raw-manual-token');
  });

  it('rejects an invalid/expired token before saving anything', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'Invalid token' } }, 400));
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(app)
      .post('/api/targets/facebook/manual')
      .set('Cookie', accessTokenCookie)
      .send({ page_id: 'bad-page', name: 'Bad Page', access_token: 'invalid-token' });

    expect(res.status).toBe(400);

    const [target] = await getDb()
      .select()
      .from(publishTargets)
      .where(and(eq(publishTargets.userId, userId), eq(publishTargets.externalId, 'bad-page')));
    expect(target).toBeUndefined();
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/targets/facebook/manual')
      .send({ page_id: 'x', name: 'x', access_token: 'x' });
    expect(res.status).toBe(401);
  });

  it('rejects a request missing required fields', async () => {
    const res = await request(app)
      .post('/api/targets/facebook/manual')
      .set('Cookie', accessTokenCookie)
      .send({ page_id: 'only-page-id' });
    expect(res.status).toBe(400);
  });
});

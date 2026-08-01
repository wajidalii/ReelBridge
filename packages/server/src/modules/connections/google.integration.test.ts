import 'dotenv/config';
import { and, eq, like } from 'drizzle-orm';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb, getPool, platformConnections, publishTargets, users } from '@reelbridge/shared';
import { createApp } from '../../app.js';
import { signOAuthState, verifyOAuthState } from './oauthState.js';

// `||=` rather than `??=`: a real .env commonly has these as empty-string
// placeholders (see .env.example), which `??=` would not treat as "unset".
process.env.JWT_SECRET ||= 'test-jwt-secret-for-integration-tests-only';
process.env.ENCRYPTION_KEY ||= 'l7h1fhRbl+M+3zH5zb+r7GdNaEDefpRIrBBXA7DB1NQ=';
process.env.GOOGLE_CLIENT_ID ||= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ||= 'test-client-secret';

const TEST_EMAIL_PREFIX = 'reelbridge-google-oauth-test+';

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function redirectLocation(res: { headers: Record<string, string | undefined> }): URL {
  const location = res.headers.location;
  if (!location) throw new Error('Expected a Location header on the redirect response');
  return new URL(location, 'http://localhost');
}

describe.skipIf(!dbReachable)('Google OAuth connect flow', () => {
  const app = createApp();
  let userId: string;

  beforeAll(async () => {
    const [user] = await getDb()
      .insert(users)
      .values({ email: `${TEST_EMAIL_PREFIX}${Date.now()}@example.com`, passwordHash: 'unused' })
      .returning();
    if (!user) throw new Error('failed to insert test user');
    userId = user.id;
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

  it('exchanges code, discovers YouTube channels, and upserts publish_targets with the refresh token encrypted', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return jsonResponse({
          access_token: 'google-access-token',
          refresh_token: 'google-refresh-token',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/youtube.upload',
        });
      }
      if (urlStr.includes('/youtube/v3/channels')) {
        return jsonResponse({
          items: [
            {
              id: 'channel-1',
              snippet: { title: 'My Channel', thumbnails: { default: { url: 'https://x/thumb.jpg' } } },
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const state = signOAuthState({
      userId,
      nonce: 'test-nonce',
      platform: 'google',
      intent: 'youtube',
    });
    const res = await request(app).get(
      `/api/connections/google/callback?code=auth-code-123&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    const location = redirectLocation(res);
    expect(location.pathname).toBe('/connect/youtube');
    expect(location.searchParams.get('connected')).toBe('1');
    expect(location.searchParams.get('channels')).toBe('1');

    const targets = await getDb()
      .select()
      .from(publishTargets)
      .where(eq(publishTargets.userId, userId));
    const ytTargets = targets.filter((t) => t.platform === 'youtube_channel');
    expect(ytTargets).toHaveLength(1);
    expect(ytTargets[0]?.externalId).toBe('channel-1');
    expect(ytTargets[0]?.displayName).toBe('My Channel');
    // TDD.md §3: youtube_channel rows use the connection-level refresh token,
    // not a per-target access token.
    expect(ytTargets[0]?.accessTokenCiphertext).toBeNull();

    const [connection] = await getDb()
      .select()
      .from(platformConnections)
      .where(and(eq(platformConnections.userId, userId), eq(platformConnections.platform, 'google')));
    expect(connection).toBeDefined();
    expect(connection?.refreshTokenCiphertext).toBeTruthy();
    // Tokens must be encrypted at rest, never stored/returned in plaintext.
    expect(connection?.accessTokenCiphertext).not.toBe('google-access-token');
    expect(connection?.refreshTokenCiphertext).not.toBe('google-refresh-token');
    expect(res.body).not.toHaveProperty('accessToken');
  });

  it('keeps the prior refresh token when a reconnect omits a new one', async () => {
    const email = `${TEST_EMAIL_PREFIX}reconnect-${Date.now()}@example.com`;
    const [user] = await getDb().insert(users).values({ email, passwordHash: 'unused' }).returning();
    if (!user) throw new Error('failed to insert test user');

    const firstFetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return jsonResponse({
          access_token: 'first-access-token',
          refresh_token: 'first-refresh-token',
          expires_in: 3600,
        });
      }
      if (urlStr.includes('/youtube/v3/channels')) {
        return jsonResponse({ items: [{ id: 'channel-2', snippet: { title: 'Channel Two' } }] });
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', firstFetchMock);

    const firstState = signOAuthState({
      userId: user.id,
      nonce: 'nonce-1',
      platform: 'google',
      intent: 'youtube',
    });
    await request(app).get(
      `/api/connections/google/callback?code=first-code&state=${encodeURIComponent(firstState)}`,
    );

    const [connectionAfterFirst] = await getDb()
      .select()
      .from(platformConnections)
      .where(and(eq(platformConnections.userId, user.id), eq(platformConnections.platform, 'google')));
    const refreshTokenAfterFirst = connectionAfterFirst?.refreshTokenCiphertext;
    expect(refreshTokenAfterFirst).toBeTruthy();

    const secondFetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        // No refresh_token this time — Google omits it when it isn't a fresh grant.
        return jsonResponse({ access_token: 'second-access-token', expires_in: 3600 });
      }
      if (urlStr.includes('/youtube/v3/channels')) {
        return jsonResponse({ items: [{ id: 'channel-2', snippet: { title: 'Channel Two' } }] });
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', secondFetchMock);

    const secondState = signOAuthState({
      userId: user.id,
      nonce: 'nonce-2',
      platform: 'google',
      intent: 'youtube',
    });
    const res = await request(app).get(
      `/api/connections/google/callback?code=second-code&state=${encodeURIComponent(secondState)}`,
    );
    expect(res.status).toBe(302);

    const [connectionAfterSecond] = await getDb()
      .select()
      .from(platformConnections)
      .where(and(eq(platformConnections.userId, user.id), eq(platformConnections.platform, 'google')));
    expect(connectionAfterSecond?.refreshTokenCiphertext).toBe(refreshTokenAfterFirst);

    await getDb().delete(users).where(eq(users.id, user.id));
  });

  it('treats zero discovered channels as a normal outcome, not an error', async () => {
    const email = `${TEST_EMAIL_PREFIX}no-channels-${Date.now()}@example.com`;
    const [user] = await getDb().insert(users).values({ email, passwordHash: 'unused' }).returning();
    if (!user) throw new Error('failed to insert test user');

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return jsonResponse({
          access_token: 'no-channels-access-token',
          refresh_token: 'no-channels-refresh-token',
          expires_in: 3600,
        });
      }
      if (urlStr.includes('/youtube/v3/channels')) {
        return jsonResponse({ items: [] });
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const state = signOAuthState({
      userId: user.id,
      nonce: 'no-channels-nonce',
      platform: 'google',
      intent: 'youtube',
    });
    const res = await request(app).get(
      `/api/connections/google/callback?code=no-channels-code&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    const location = redirectLocation(res);
    expect(location.searchParams.get('connected')).toBe('1');
    expect(location.searchParams.get('channels')).toBe('0');

    const [connection] = await getDb()
      .select()
      .from(platformConnections)
      .where(and(eq(platformConnections.userId, user.id), eq(platformConnections.platform, 'google')));
    expect(connection).toBeDefined();

    await getDb().delete(users).where(eq(users.id, user.id));
  });

  it('fails the connect flow rather than persisting an unusable connection when Google omits refresh_token on a first-ever grant', async () => {
    const email = `${TEST_EMAIL_PREFIX}no-refresh-${Date.now()}@example.com`;
    const [user] = await getDb().insert(users).values({ email, passwordHash: 'unused' }).returning();
    if (!user) throw new Error('failed to insert test user');

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return jsonResponse({ access_token: 'access-token-no-refresh', expires_in: 3600 });
      }
      if (urlStr.includes('/youtube/v3/channels')) {
        return jsonResponse({ items: [{ id: 'channel-x', snippet: { title: 'Channel X' } }] });
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const state = signOAuthState({
      userId: user.id,
      nonce: 'no-refresh-nonce',
      platform: 'google',
      intent: 'youtube',
    });
    const res = await request(app).get(
      `/api/connections/google/callback?code=no-refresh-code&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    const location = redirectLocation(res);
    expect(location.searchParams.get('connected')).toBeNull();
    expect(location.searchParams.get('error')).toBeTruthy();

    const [connection] = await getDb()
      .select()
      .from(platformConnections)
      .where(and(eq(platformConnections.userId, user.id), eq(platformConnections.platform, 'google')));
    expect(connection).toBeUndefined();

    await getDb().delete(users).where(eq(users.id, user.id));
  });

  it('redirects with an error param on an invalid/expired state', async () => {
    const res = await request(app).get(
      '/api/connections/google/callback?code=x&state=not-a-real-signed-token',
    );
    expect(res.status).toBe(302);
    const location = redirectLocation(res);
    expect(location.pathname).toBe('/connect/youtube');
    expect(location.searchParams.get('error')).toMatch(/invalid|expired/i);
  });

  it('redirects with an error param on a missing code or state', async () => {
    const res = await request(app).get('/api/connections/google/callback');
    expect(res.status).toBe(302);
    const location = redirectLocation(res);
    expect(location.searchParams.get('error')).toMatch(/missing/i);
  });

  it('signs a state with platform=google and intent=youtube from /start', async () => {
    const email = `${TEST_EMAIL_PREFIX}intent-${Date.now()}@example.com`;
    const signupRes = await request(app)
      .post('/api/auth/signup')
      .send({ email, password: 'correct horse battery staple' });
    expect(signupRes.status).toBe(201);
    const authCookies = signupRes.headers['set-cookie'] as unknown as string[];

    const startRes = await request(app)
      .get('/api/connections/google/start')
      .set('Cookie', authCookies);
    expect(startRes.status).toBe(302);
    const oauthUrl = redirectLocation(startRes);
    expect(oauthUrl.hostname).toBe('accounts.google.com');
    expect(oauthUrl.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/youtube.upload',
    );
    const state = oauthUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    const payload = verifyOAuthState(state!);
    expect(payload.platform).toBe('google');
    expect(payload.intent).toBe('youtube');
  });
});

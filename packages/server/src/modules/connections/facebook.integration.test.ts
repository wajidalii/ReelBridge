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
process.env.FB_APP_ID ||= 'test-app-id';
process.env.FB_APP_SECRET ||= 'test-app-secret';

const TEST_EMAIL_PREFIX = 'reelbridge-facebook-oauth-test+';

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

describe.skipIf(!dbReachable)('Facebook OAuth connect flow', () => {
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

  it('exchanges code, discovers pages + linked Instagram accounts, and upserts publish_targets', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('/oauth/access_token') && urlStr.includes('code=auth-code-123')) {
        return jsonResponse({ access_token: 'short-lived-token' });
      }
      if (
        urlStr.includes('/oauth/access_token') &&
        urlStr.includes('grant_type=fb_exchange_token')
      ) {
        return jsonResponse({ access_token: 'long-lived-token', expires_in: 5184000 });
      }
      if (urlStr.includes('/me/accounts')) {
        return jsonResponse({
          data: [
            { id: 'page-1', name: 'Page One', access_token: 'page-1-token' },
            { id: 'page-2', name: 'Page Two', access_token: 'page-2-token' },
          ],
        });
      }
      if (
        urlStr.includes('graph.facebook.com/v21.0/page-1') &&
        urlStr.includes('instagram_business_account')
      ) {
        return jsonResponse({
          instagram_business_account: { id: 'ig-1', username: 'page_one_ig' },
        });
      }
      if (urlStr.includes('graph.facebook.com/v21.0/ig-1') && urlStr.includes('account_type')) {
        return jsonResponse({ account_type: 'BUSINESS' });
      }
      if (urlStr.includes('graph.facebook.com/v21.0/page-2')) {
        return jsonResponse({});
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const state = signOAuthState({
      userId,
      nonce: 'test-nonce',
      platform: 'facebook',
      intent: 'facebook',
    });
    const res = await request(app).get(
      `/api/connections/facebook/callback?code=auth-code-123&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    const location = redirectLocation(res);
    expect(location.pathname).toBe('/connect/facebook');
    expect(location.searchParams.get('connected')).toBe('1');
    expect(location.searchParams.get('pages')).toBe('2');
    expect(location.searchParams.get('instagram')).toBe('1');

    const targets = await getDb()
      .select()
      .from(publishTargets)
      .where(eq(publishTargets.userId, userId));
    const fbTargets = targets.filter((t) => t.platform === 'facebook_page');
    const igTargets = targets.filter((t) => t.platform === 'instagram_business');
    expect(fbTargets).toHaveLength(2);
    expect(igTargets).toHaveLength(1);
    expect(igTargets[0]?.externalId).toBe('ig-1');

    const [connection] = await getDb()
      .select()
      .from(platformConnections)
      .where(
        and(eq(platformConnections.userId, userId), eq(platformConnections.platform, 'facebook')),
      );
    expect(connection).toBeDefined();
    // Token must be encrypted at rest, never stored/returned in plaintext.
    expect(connection?.accessTokenCiphertext).not.toBe('long-lived-token');
    expect(res.body).not.toHaveProperty('accessToken');
  });

  it('rejects a Page whose linked Instagram account is Personal, and never surfaces it as a target', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('/oauth/access_token') && urlStr.includes('code=auth-code-personal')) {
        return jsonResponse({ access_token: 'short-lived-token-personal' });
      }
      if (
        urlStr.includes('/oauth/access_token') &&
        urlStr.includes('grant_type=fb_exchange_token')
      ) {
        return jsonResponse({ access_token: 'long-lived-token-personal', expires_in: 5184000 });
      }
      if (urlStr.includes('/me/accounts')) {
        return jsonResponse({
          data: [{ id: 'page-3', name: 'Page Three', access_token: 'page-3-token' }],
        });
      }
      if (
        urlStr.includes('graph.facebook.com/v21.0/page-3') &&
        urlStr.includes('instagram_business_account')
      ) {
        return jsonResponse({
          instagram_business_account: { id: 'ig-3', username: 'page_three_ig' },
        });
      }
      if (urlStr.includes('graph.facebook.com/v21.0/ig-3') && urlStr.includes('account_type')) {
        return jsonResponse({ account_type: 'PERSONAL' });
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const state = signOAuthState({
      userId,
      nonce: 'test-nonce-personal',
      platform: 'facebook',
      intent: 'facebook',
    });
    const res = await request(app).get(
      `/api/connections/facebook/callback?code=auth-code-personal&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    const location = redirectLocation(res);
    expect(location.searchParams.get('pages')).toBe('1');
    expect(location.searchParams.get('instagram')).toBe('0');

    const targets = await getDb()
      .select()
      .from(publishTargets)
      .where(and(eq(publishTargets.userId, userId), eq(publishTargets.platform, 'instagram_business')));
    expect(targets.find((t) => t.externalId === 'ig-3')).toBeUndefined();
  });

  it('treats an empty /me/accounts result as a normal outcome, not an error (Business Portfolio gap)', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('/oauth/access_token') && urlStr.includes('code=auth-code-empty')) {
        return jsonResponse({ access_token: 'short-lived-token-2' });
      }
      if (
        urlStr.includes('/oauth/access_token') &&
        urlStr.includes('grant_type=fb_exchange_token')
      ) {
        return jsonResponse({ access_token: 'long-lived-token-2', expires_in: 5184000 });
      }
      if (urlStr.includes('/me/accounts')) {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const state = signOAuthState({
      userId,
      nonce: 'test-nonce-2',
      platform: 'facebook',
      intent: 'facebook',
    });
    const res = await request(app).get(
      `/api/connections/facebook/callback?code=auth-code-empty&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    const location = redirectLocation(res);
    expect(location.searchParams.get('pages')).toBe('0');
    expect(location.searchParams.get('instagram')).toBe('0');
  });

  it('redirects with an error param on an invalid/expired state', async () => {
    const res = await request(app).get(
      '/api/connections/facebook/callback?code=x&state=not-a-real-signed-token',
    );
    expect(res.status).toBe(302);
    const location = redirectLocation(res);
    expect(location.pathname).toBe('/connect/facebook');
    expect(location.searchParams.get('error')).toMatch(/invalid|expired/i);
  });

  it('redirects with an error param on a missing code or state', async () => {
    const res = await request(app).get('/api/connections/facebook/callback');
    expect(res.status).toBe(302);
    const location = redirectLocation(res);
    expect(location.searchParams.get('error')).toMatch(/missing/i);
  });

  it('threads the intent (facebook vs instagram) through /start -> signed state -> /callback redirect', async () => {
    // A real browser redirect round-trip drops the original click's query
    // string, so /start must embed `intent` in the signed state and /callback
    // must echo it back — this is what lets the client show Instagram-specific
    // copy after the real OAuth flow, not just when the URL is hand-crafted.
    const email = `${TEST_EMAIL_PREFIX}intent-${Date.now()}@example.com`;
    const signupRes = await request(app)
      .post('/api/auth/signup')
      .send({ email, password: 'correct horse battery staple' });
    expect(signupRes.status).toBe(201);
    const authCookies = signupRes.headers['set-cookie'] as unknown as string[];

    const startRes = await request(app)
      .get('/api/connections/facebook/start?intent=instagram')
      .set('Cookie', authCookies);
    expect(startRes.status).toBe(302);
    const oauthUrl = redirectLocation(startRes);
    const state = oauthUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(verifyOAuthState(state!).intent).toBe('instagram');

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes('/oauth/access_token') && urlStr.includes('code=intent-test-code')) {
        return jsonResponse({ access_token: 'short-lived-token-intent' });
      }
      if (
        urlStr.includes('/oauth/access_token') &&
        urlStr.includes('grant_type=fb_exchange_token')
      ) {
        return jsonResponse({ access_token: 'long-lived-token-intent', expires_in: 5184000 });
      }
      if (urlStr.includes('/me/accounts')) {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const callbackRes = await request(app).get(
      `/api/connections/facebook/callback?code=intent-test-code&state=${encodeURIComponent(state!)}`,
    );
    expect(callbackRes.status).toBe(302);
    const location = redirectLocation(callbackRes);
    expect(location.searchParams.get('intent')).toBe('instagram');
    expect(location.searchParams.get('connected')).toBe('1');
  });
});

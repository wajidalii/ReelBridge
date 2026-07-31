import 'dotenv/config';
import { createHash } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, getPool } from '../../db/client.js';
import { refreshTokens, users } from '../../db/schema.js';

process.env.JWT_SECRET ??= 'test-jwt-secret-for-integration-tests-only';

const TEST_EMAIL_PREFIX = 'reelbridge-auth-integration-test+';

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

describe.skipIf(!dbReachable)('auth: signup/login/logout/me/refresh', () => {
  const app = createApp();
  const email = `${TEST_EMAIL_PREFIX}${Date.now()}@example.com`;
  const password = 'correct-horse-battery-staple';

  afterAll(async () => {
    const db = getDb();
    await db.delete(users).where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
    await getPool().end();
  });

  it('signup validates email uniqueness and hashes the password', async () => {
    const signupRes = await request(app).post('/api/auth/signup').send({ email, password });
    expect(signupRes.status).toBe(201);
    expect(signupRes.body).toMatchObject({ email });
    expect(signupRes.headers['set-cookie']).toBeDefined();

    const [row] = await getDb().select().from(users).where(eq(users.email, email));
    expect(row).toBeDefined();
    expect(row?.passwordHash).not.toBe(password);

    const duplicateRes = await request(app).post('/api/auth/signup').send({ email, password });
    expect(duplicateRes.status).toBe(409);
  });

  it('login sets cookies and /me returns the current user from a valid cookie, 401 otherwise', async () => {
    const loginRes = await request(app).post('/api/auth/login').send({ email, password });
    expect(loginRes.status).toBe(200);
    const cookies = loginRes.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('reelbridge_access_token='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('reelbridge_refresh_token='))).toBe(true);

    const meRes = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(meRes.status).toBe(200);
    expect(meRes.body).toMatchObject({ email });

    const unauthenticatedRes = await request(app).get('/api/auth/me');
    expect(unauthenticatedRes.status).toBe(401);
  });

  it('refresh rotates the refresh token: the old one stops working after use', async () => {
    const loginRes = await request(app).post('/api/auth/login').send({ email, password });
    const originalCookies = loginRes.headers['set-cookie'] as unknown as string[];

    const refreshRes = await request(app).post('/api/auth/refresh').set('Cookie', originalCookies);
    expect(refreshRes.status).toBe(204);
    const rotatedCookies = refreshRes.headers['set-cookie'] as unknown as string[];
    expect(rotatedCookies).toBeDefined();

    // Reusing the original (now-rotated-away) refresh token must fail.
    const reuseRes = await request(app).post('/api/auth/refresh').set('Cookie', originalCookies);
    expect(reuseRes.status).toBe(401);

    // The newly-issued refresh token from rotation should still work.
    const secondRefreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', rotatedCookies);
    expect(secondRefreshRes.status).toBe(204);
  });

  it('logout revokes the refresh token server-side, not just clearing the cookie client-side', async () => {
    const loginRes = await request(app).post('/api/auth/login').send({ email, password });
    const cookies = loginRes.headers['set-cookie'] as unknown as string[];

    const refreshCookie = cookies.find((c) => c.startsWith('reelbridge_refresh_token='));
    expect(refreshCookie).toBeDefined();
    const rawRefreshToken = refreshCookie!.split(';')[0]!.split('=')[1]!;

    const logoutRes = await request(app).post('/api/auth/logout').set('Cookie', cookies);
    expect(logoutRes.status).toBe(204);

    const [row] = await getDb()
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashForTest(rawRefreshToken)));
    expect(row?.revokedAt).not.toBeNull();

    // Presenting the (now server-side-revoked) refresh token must fail — this is
    // the behavior that distinguishes real revocation from merely clearing a cookie.
    const refreshAfterLogoutRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', [refreshCookie!]);
    expect(refreshAfterLogoutRes.status).toBe(401);
  });
});

// Mirrors refreshTokens.ts's private hashing so the test can look up the row by raw token.
function hashForTest(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

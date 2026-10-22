import 'dotenv/config';
import { eq, like } from 'drizzle-orm';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDb, getPool, subscriptions, users } from '@reelbridge/shared';
import { createApp } from '../../app.js';
import { InMemoryEmailProvider, setEmailProviderForTests } from '../email/provider.js';

process.env.JWT_SECRET ||= 'test-jwt-secret-for-integration-tests-only';

const TEST_EMAIL_PREFIX = 'reelbridge-auth-flows-test+';

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

function tokenFromLink(text: string): string {
  const match = /token=([^\s&]+)/.exec(text);
  if (!match) throw new Error(`no token in email body: ${text}`);
  return decodeURIComponent(match[1]!);
}

describe.skipIf(!dbReachable)('auth: email verification, password reset, invite gating', () => {
  const app = createApp();
  const mailbox = new InMemoryEmailProvider();
  const password = 'correct-horse-battery-staple';

  beforeAll(() => {
    setEmailProviderForTests(mailbox);
  });
  afterEach(() => {
    delete process.env.SIGNUP_MODE;
    delete process.env.SIGNUP_INVITE_CODES;
  });
  afterAll(async () => {
    setEmailProviderForTests(undefined);
    await getDb()
      .delete(users)
      .where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
    await getPool().end();
  });

  it('signup sends a verification email; the link verifies once and is then dead', async () => {
    const email = `${TEST_EMAIL_PREFIX}verify-${Date.now()}@example.com`;
    const signupRes = await request(app).post('/api/auth/signup').send({ email, password });
    expect(signupRes.status).toBe(201);
    expect(signupRes.body.emailVerified).toBe(false);

    const sent = mailbox.sent.find((m) => m.to === email && /verify/i.test(m.subject));
    expect(sent).toBeDefined();
    const token = tokenFromLink(sent!.text);

    const verifyRes = await request(app).post('/api/auth/verify-email').send({ token });
    expect(verifyRes.status).toBe(200);
    const [row] = await getDb().select().from(users).where(eq(users.email, email));
    expect(row?.emailVerifiedAt).not.toBeNull();

    const reuse = await request(app).post('/api/auth/verify-email').send({ token });
    expect(reuse.status).toBe(400);

    // A default-plan subscription row is attached at signup (billing enforcement point).
    const [sub] = await getDb()
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, row!.id));
    expect(sub).toBeDefined();
  });

  it('password reset: request never reveals whether the email exists; confirm rotates the password and kills sessions', async () => {
    const email = `${TEST_EMAIL_PREFIX}reset-${Date.now()}@example.com`;
    await request(app).post('/api/auth/signup').send({ email, password });
    const loginRes = await request(app).post('/api/auth/login').send({ email, password });
    const oldCookies = loginRes.headers['set-cookie'] as unknown as string[];

    const unknownRes = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: `${TEST_EMAIL_PREFIX}nobody@example.com` });
    const knownRes = await request(app).post('/api/auth/forgot-password').send({ email });
    expect(unknownRes.status).toBe(200);
    expect(knownRes.body).toEqual(unknownRes.body);

    const sent = mailbox.sent.find((m) => m.to === email && /reset/i.test(m.subject));
    expect(sent).toBeDefined();
    const token = tokenFromLink(sent!.text);

    const newPassword = 'a-brand-new-password-123';
    const resetRes = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: newPassword });
    expect(resetRes.status).toBe(200);

    expect((await request(app).post('/api/auth/login').send({ email, password })).status).toBe(401);
    expect(
      (await request(app).post('/api/auth/login').send({ email, password: newPassword })).status,
    ).toBe(200);

    // The pre-reset refresh token no longer works.
    const refreshRes = await request(app).post('/api/auth/refresh').set('Cookie', oldCookies);
    expect(refreshRes.status).toBe(401);

    // Single use.
    const again = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'yet-another-password-456' });
    expect(again.status).toBe(400);
  });

  it('invite mode blocks signup without a valid code and admits one with it', async () => {
    process.env.SIGNUP_MODE = 'invite';
    process.env.SIGNUP_INVITE_CODES = 'tester-code';
    const email = `${TEST_EMAIL_PREFIX}invite-${Date.now()}@example.com`;

    expect((await request(app).get('/api/auth/signup-policy')).body).toEqual({ mode: 'invite' });

    const blocked = await request(app).post('/api/auth/signup').send({ email, password });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('invite_required');

    const admitted = await request(app)
      .post('/api/auth/signup')
      .send({ email, password, invite_code: 'tester-code' });
    expect(admitted.status).toBe(201);
  });

  it('rejects over-long passwords and normalizes email case', async () => {
    const email = `${TEST_EMAIL_PREFIX}Case-${Date.now()}@Example.com`;
    const tooLong = await request(app)
      .post('/api/auth/signup')
      .send({ email, password: 'x'.repeat(65) });
    expect(tooLong.status).toBe(400);

    const ok = await request(app).post('/api/auth/signup').send({ email, password });
    expect(ok.status).toBe(201);
    expect(ok.body.email).toBe(email.toLowerCase());
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: email.toUpperCase(), password });
    expect(login.status).toBe(200);
  });

  it('access tokens are rejected when used as OAuth state and vice versa (audience pinning)', async () => {
    const email = `${TEST_EMAIL_PREFIX}aud-${Date.now()}@example.com`;
    const signupRes = await request(app).post('/api/auth/signup').send({ email, password });
    const cookies = signupRes.headers['set-cookie'] as unknown as string[];
    const access = cookies
      .find((c) => c.startsWith('reelbridge_access_token='))!
      .split(';')[0]!
      .split('=')[1]!;
    const { verifyOAuthState } = await import('../connections/oauthState.js');
    expect(() => verifyOAuthState(access)).toThrow();
  });
});

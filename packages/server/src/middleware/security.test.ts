import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAllowedOrigin, requireTrustedOrigin } from './security.js';

function appWithOriginCheck() {
  const app = express();
  app.use(requireTrustedOrigin);
  app.post('/mutate', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/read', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('requireTrustedOrigin', () => {
  const original = process.env.CLIENT_ORIGIN;
  beforeEach(() => {
    process.env.CLIENT_ORIGIN = 'https://app.example.com, https://staging.example.com/';
  });
  afterEach(() => {
    process.env.CLIENT_ORIGIN = original;
  });

  it('accepts a mutating request from an allowed origin (trailing slash tolerated)', async () => {
    const app = appWithOriginCheck();
    expect(
      (await request(app).post('/mutate').set('Origin', 'https://app.example.com')).status,
    ).toBe(200);
    expect(
      (await request(app).post('/mutate').set('Origin', 'https://staging.example.com')).status,
    ).toBe(200);
  });

  it('rejects a mutating request from a foreign origin', async () => {
    const app = appWithOriginCheck();
    const res = await request(app).post('/mutate').set('Origin', 'https://evil.example.net');
    expect(res.status).toBe(403);
  });

  it('rejects a cross-site fetch flagged by Sec-Fetch-Site even without an Origin header', async () => {
    const app = appWithOriginCheck();
    const res = await request(app).post('/mutate').set('Sec-Fetch-Site', 'cross-site');
    expect(res.status).toBe(403);
  });

  it('lets non-browser clients (no Origin, no Sec-Fetch-Site) and all GETs through', async () => {
    const app = appWithOriginCheck();
    expect((await request(app).post('/mutate')).status).toBe(200);
    expect((await request(app).get('/read').set('Origin', 'https://evil.example.net')).status).toBe(
      200,
    );
  });

  it('isAllowedOrigin is exact-match on scheme+host+port', () => {
    expect(isAllowedOrigin('https://app.example.com')).toBe(true);
    expect(isAllowedOrigin('http://app.example.com')).toBe(false);
    expect(isAllowedOrigin('https://app.example.com.evil.net')).toBe(false);
    expect(isAllowedOrigin(undefined)).toBe(false);
  });
});

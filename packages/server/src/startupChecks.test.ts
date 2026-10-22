import { describe, expect, it } from 'vitest';
import { assertRequiredEnv } from './startupChecks.js';

const base = {
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  JWT_SECRET: 'a'.repeat(40),
  ENCRYPTION_KEY: 'b'.repeat(44),
  S3_BUCKET: 'bucket',
};

describe('assertRequiredEnv', () => {
  it('passes with a complete development config', () => {
    expect(() => assertRequiredEnv({ ...base, NODE_ENV: 'development' })).not.toThrow();
  });

  it('names every missing variable', () => {
    expect(() => assertRequiredEnv({ DATABASE_URL: 'x' })).toThrow(/REDIS_URL, JWT_SECRET/);
  });

  it('rejects a short JWT secret and a JWT secret reused as the encryption key', () => {
    expect(() => assertRequiredEnv({ ...base, JWT_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() =>
      assertRequiredEnv({
        ...base,
        JWT_SECRET: base.ENCRYPTION_KEY,
        ENCRYPTION_KEY: base.ENCRYPTION_KEY,
      }),
    ).toThrow(/distinct/);
  });

  it('requires real origins in production', () => {
    expect(() =>
      assertRequiredEnv({
        ...base,
        NODE_ENV: 'production',
        CLIENT_ORIGIN: 'http://localhost:5173',
        API_BASE_URL: 'https://api.example.com',
      }),
    ).toThrow(/CLIENT_ORIGIN/);
    expect(() =>
      assertRequiredEnv({
        ...base,
        NODE_ENV: 'production',
        CLIENT_ORIGIN: 'https://app.example.com',
        API_BASE_URL: 'http://api.example.com',
      }),
    ).toThrow(/API_BASE_URL/);
  });
});

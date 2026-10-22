import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    // Processors log expected failures at error level during tests; keep
    // the run output readable. Tests that assert on logging use console.*.
    env: { LOG_LEVEL: 'silent', LOG_PRETTY: 'false', BCRYPT_COST: '6' },
    // Integration tests talk to real Postgres/Redis; give them headroom on a
    // loaded CI runner rather than failing on timing.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

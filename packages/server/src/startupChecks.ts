/**
 * Fail fast at boot on a missing/weak secret instead of at the first request
 * that needs it (which for ENCRYPTION_KEY would be the first OAuth callback —
 * i.e. in front of a user).
 */
export function assertRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
  const required = ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'ENCRYPTION_KEY', 'S3_BUCKET'];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if ((env.JWT_SECRET ?? '').length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters (use a random 256-bit value)');
  }
  if (env.JWT_SECRET === env.ENCRYPTION_KEY) {
    throw new Error('JWT_SECRET and ENCRYPTION_KEY must be distinct secrets');
  }
  if (env.NODE_ENV === 'production') {
    if (!env.CLIENT_ORIGIN || env.CLIENT_ORIGIN.includes('localhost')) {
      throw new Error('CLIENT_ORIGIN must be set to the real client origin in production');
    }
    if (!env.API_BASE_URL || env.API_BASE_URL.startsWith('http://')) {
      throw new Error('API_BASE_URL must be an https:// URL in production');
    }
  }
}

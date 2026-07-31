import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { refreshTokens } from '../../db/schema.js';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_TOKEN_BYTES = 32;

/**
 * Refresh tokens are high-entropy random values, not user-chosen secrets, so a
 * fast cryptographic hash (not bcrypt) is the right tool here: the guessing
 * resistance comes from the token's entropy, not from hashing cost.
 */
function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export async function issueRefreshToken(userId: string): Promise<string> {
  const rawToken = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await getDb()
    .insert(refreshTokens)
    .values({
      userId,
      tokenHash: hashRefreshToken(rawToken),
      expiresAt,
    });

  return rawToken;
}

export async function findValidRefreshToken(
  rawToken: string,
): Promise<{ id: string; userId: string } | null> {
  const tokenHash = hashRefreshToken(rawToken);
  const [row] = await getDb()
    .select({ id: refreshTokens.id, userId: refreshTokens.userId })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function revokeRefreshTokenById(id: string): Promise<void> {
  await getDb()
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.id, id));
}

export async function revokeRefreshTokenByRawToken(rawToken: string): Promise<void> {
  const tokenHash = hashRefreshToken(rawToken);
  await getDb()
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));
}

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { authTokens, getDb } from '@reelbridge/shared';

export type AuthTokenType = 'email_verification' | 'password_reset';

const TTL_MS: Record<AuthTokenType, number> = {
  email_verification: 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
};

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/** Issues a fresh single-use token, invalidating any unused ones of the same type for this user. */
export async function issueAuthToken(userId: string, type: AuthTokenType): Promise<string> {
  const db = getDb();
  const rawToken = randomBytes(32).toString('base64url');
  await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(
      and(eq(authTokens.userId, userId), eq(authTokens.type, type), isNull(authTokens.usedAt)),
    );
  await db.insert(authTokens).values({
    userId,
    type,
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + TTL_MS[type]),
  });
  return rawToken;
}

/**
 * Atomically marks the token used and returns its user — the UPDATE ... WHERE
 * used_at IS NULL is what makes two concurrent submissions of the same link
 * result in exactly one success.
 */
export async function consumeAuthToken(
  rawToken: string,
  type: AuthTokenType,
): Promise<{ userId: string } | null> {
  const [row] = await getDb()
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(rawToken)),
        eq(authTokens.type, type),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: authTokens.userId });
  return row ?? null;
}

/** Housekeeping: drop expired/used rows so the table doesn't grow forever. */
export async function deleteStaleAuthTokens(olderThan = new Date()): Promise<void> {
  await getDb()
    .delete(authTokens)
    .where(or(lt(authTokens.expiresAt, olderThan), lt(authTokens.usedAt, olderThan)));
}

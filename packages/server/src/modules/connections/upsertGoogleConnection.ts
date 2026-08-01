import { encrypt, getDb, platformConnections, publishTargets } from '@reelbridge/shared';
import type { YouTubeChannel } from '@reelbridge/platform-youtube';
import { and, eq } from 'drizzle-orm';

export interface UpsertGoogleConnectionResult {
  connectionId: string;
  channels: Array<{ id: string; title: string }>;
}

/**
 * publish_targets.access_token_ciphertext stays null for youtube_channel rows
 * (TDD.md §3) — publishing uses the connection-level refresh token instead of
 * a per-target token the way Facebook Page tokens work.
 */
export async function upsertGoogleConnection(
  userId: string,
  accessToken: string,
  refreshToken: string | undefined,
  expiresInSeconds: number | undefined,
  scope: string | undefined,
  channels: YouTubeChannel[],
): Promise<UpsertGoogleConnectionResult> {
  const db = getDb();
  const encryptedAccessToken = encrypt(accessToken);
  const encryptedRefreshToken = refreshToken ? encrypt(refreshToken) : null;
  const tokenExpiresAt = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null;
  const scopes = scope ? scope.split(' ') : [];

  const [existingConnection] = await db
    .select({ id: platformConnections.id })
    .from(platformConnections)
    .where(and(eq(platformConnections.userId, userId), eq(platformConnections.platform, 'google')));

  // A brand-new connection with no refresh token would be silently dead once
  // its ~1h access token expires — unlike Facebook's long-lived user token,
  // there's no fallback here. access_type=offline+prompt=consent (oauth.ts)
  // should always yield one on a first-ever grant; treat its absence as a
  // failure rather than persisting an unusable connection.
  if (!existingConnection && !encryptedRefreshToken) {
    throw new Error(
      'Google did not return a refresh_token on first authorization; cannot create a usable connection',
    );
  }

  let connectionId: string;
  if (existingConnection) {
    connectionId = existingConnection.id;
    await db
      .update(platformConnections)
      .set({
        accessTokenCiphertext: encryptedAccessToken.ciphertext,
        accessTokenIv: encryptedAccessToken.iv,
        accessTokenTag: encryptedAccessToken.tag,
        // Google only reissues refresh_token when prompt=consent triggers a
        // fresh grant; if this exchange didn't include one, keep the prior
        // refresh token rather than nulling out an otherwise-still-valid one.
        ...(encryptedRefreshToken && {
          refreshTokenCiphertext: encryptedRefreshToken.ciphertext,
          refreshTokenIv: encryptedRefreshToken.iv,
          refreshTokenTag: encryptedRefreshToken.tag,
        }),
        tokenExpiresAt,
        scopes,
        status: 'active',
        updatedAt: new Date(),
      })
      .where(eq(platformConnections.id, connectionId));
  } else {
    const [inserted] = await db
      .insert(platformConnections)
      .values({
        userId,
        platform: 'google',
        externalAccountId: 'me',
        displayName: 'Google',
        accessTokenCiphertext: encryptedAccessToken.ciphertext,
        accessTokenIv: encryptedAccessToken.iv,
        accessTokenTag: encryptedAccessToken.tag,
        refreshTokenCiphertext: encryptedRefreshToken?.ciphertext,
        refreshTokenIv: encryptedRefreshToken?.iv,
        refreshTokenTag: encryptedRefreshToken?.tag,
        tokenExpiresAt,
        scopes,
      })
      .returning();
    if (!inserted) {
      throw new Error('Failed to create platform_connections row');
    }
    connectionId = inserted.id;
  }

  for (const channel of channels) {
    await db
      .insert(publishTargets)
      .values({
        userId,
        platformConnectionId: connectionId,
        platform: 'youtube_channel',
        externalId: channel.id,
        displayName: channel.title,
        avatarUrl: channel.thumbnailUrl,
        tokenSource: 'oauth',
        lastValidatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [publishTargets.userId, publishTargets.platform, publishTargets.externalId],
        set: {
          displayName: channel.title,
          avatarUrl: channel.thumbnailUrl,
          isActive: true,
          lastValidatedAt: new Date(),
        },
      });
  }

  return {
    connectionId,
    channels: channels.map((channel) => ({ id: channel.id, title: channel.title })),
  };
}

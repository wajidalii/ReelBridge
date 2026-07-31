import { encrypt, getDb, platformConnections } from '@reelbridge/shared';
import { and, eq } from 'drizzle-orm';

/**
 * Manual entry doesn't come from an OAuth handshake, but publish_targets.platform_connection_id
 * is NOT NULL — every target still needs an owning connection row. Reuses the user's real
 * OAuth-derived Facebook connection if one already exists (manual entry and OAuth discovery
 * are not mutually exclusive), otherwise creates a lightweight placeholder connection: the
 * token that actually matters for publishing lives on the publish_targets row itself.
 */
export async function getOrCreateManualFacebookConnection(userId: string): Promise<string> {
  const db = getDb();
  const [existing] = await db
    .select({ id: platformConnections.id })
    .from(platformConnections)
    .where(
      and(eq(platformConnections.userId, userId), eq(platformConnections.platform, 'facebook')),
    );
  if (existing) {
    return existing.id;
  }

  const placeholder = encrypt('manual-entry-no-oauth-token');
  const [inserted] = await db
    .insert(platformConnections)
    .values({
      userId,
      platform: 'facebook',
      externalAccountId: 'manual',
      displayName: 'Facebook (manual entry)',
      accessTokenCiphertext: placeholder.ciphertext,
      accessTokenIv: placeholder.iv,
      accessTokenTag: placeholder.tag,
      scopes: [],
    })
    .returning();
  if (!inserted) {
    throw new Error('Failed to create placeholder platform_connections row for manual entry');
  }
  return inserted.id;
}

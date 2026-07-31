import { encrypt } from '@reelbridge/shared';
import type { FacebookPage } from '@reelbridge/platform-facebook';
import { fetchPageInstagramAccount } from '@reelbridge/platform-facebook';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { platformConnections, publishTargets } from '../../db/schema.js';

export interface UpsertFacebookConnectionResult {
  connectionId: string;
  pages: Array<{ id: string; name: string }>;
  instagramTargets: Array<{ id: string; username?: string; pageId: string }>;
}

/**
 * One Facebook connection can yield many facebook_page AND instagram_business
 * targets — IG rides on the FB connection (TDD.md §3). instagram_business_account
 * lookups are best-effort per page: a failure there must not abort the whole
 * connect flow, since the Page itself is still usable without its IG account.
 */
export async function upsertFacebookConnection(
  userId: string,
  longLivedUserToken: string,
  expiresInSeconds: number | undefined,
  pages: FacebookPage[],
): Promise<UpsertFacebookConnectionResult> {
  const db = getDb();
  const encryptedUserToken = encrypt(longLivedUserToken);
  const tokenExpiresAt = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null;

  const [existingConnection] = await db
    .select({ id: platformConnections.id })
    .from(platformConnections)
    .where(
      and(eq(platformConnections.userId, userId), eq(platformConnections.platform, 'facebook')),
    );

  let connectionId: string;
  if (existingConnection) {
    connectionId = existingConnection.id;
    await db
      .update(platformConnections)
      .set({
        accessTokenCiphertext: encryptedUserToken.ciphertext,
        accessTokenIv: encryptedUserToken.iv,
        accessTokenTag: encryptedUserToken.tag,
        tokenExpiresAt,
        status: 'active',
        updatedAt: new Date(),
      })
      .where(eq(platformConnections.id, connectionId));
  } else {
    const [inserted] = await db
      .insert(platformConnections)
      .values({
        userId,
        platform: 'facebook',
        externalAccountId: 'me',
        displayName: 'Facebook',
        accessTokenCiphertext: encryptedUserToken.ciphertext,
        accessTokenIv: encryptedUserToken.iv,
        accessTokenTag: encryptedUserToken.tag,
        tokenExpiresAt,
        scopes: [],
      })
      .returning();
    if (!inserted) {
      throw new Error('Failed to create platform_connections row');
    }
    connectionId = inserted.id;
  }

  const instagramTargets: UpsertFacebookConnectionResult['instagramTargets'] = [];

  for (const page of pages) {
    const encryptedPageToken = encrypt(page.accessToken);

    await db
      .insert(publishTargets)
      .values({
        userId,
        platformConnectionId: connectionId,
        platform: 'facebook_page',
        externalId: page.id,
        displayName: page.name,
        accessTokenCiphertext: encryptedPageToken.ciphertext,
        accessTokenIv: encryptedPageToken.iv,
        accessTokenTag: encryptedPageToken.tag,
        tokenSource: 'oauth',
        lastValidatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [publishTargets.userId, publishTargets.platform, publishTargets.externalId],
        set: {
          displayName: page.name,
          accessTokenCiphertext: encryptedPageToken.ciphertext,
          accessTokenIv: encryptedPageToken.iv,
          accessTokenTag: encryptedPageToken.tag,
          isActive: true,
          lastValidatedAt: new Date(),
        },
      });

    const igAccount = await fetchPageInstagramAccount(page.id, page.accessToken).catch(() => null);
    if (igAccount) {
      await db
        .insert(publishTargets)
        .values({
          userId,
          platformConnectionId: connectionId,
          platform: 'instagram_business',
          externalId: igAccount.id,
          displayName: igAccount.username ?? igAccount.id,
          tokenSource: 'oauth',
          metadata: { linkedFacebookPageId: page.id, username: igAccount.username },
          lastValidatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [publishTargets.userId, publishTargets.platform, publishTargets.externalId],
          set: {
            displayName: igAccount.username ?? igAccount.id,
            isActive: true,
            lastValidatedAt: new Date(),
            metadata: { linkedFacebookPageId: page.id, username: igAccount.username },
          },
        });
      instagramTargets.push({ id: igAccount.id, username: igAccount.username, pageId: page.id });
    }
  }

  return {
    connectionId,
    pages: pages.map((page) => ({ id: page.id, name: page.name })),
    instagramTargets,
  };
}

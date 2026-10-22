import { GraphApiError, graphGet } from './graphClient.js';

export type InstagramHealthResult =
  | { status: 'healthy'; username?: string }
  | { status: 'personal_account' }
  | { status: 'unreachable'; reason: string };

/**
 * Health check for an instagram_business target (issue #36): confirms the
 * linked Page token can still read the IG account *and* that the account
 * is still Business/Creator (a downgrade to Personal makes publishing
 * impossible even though the token itself still works).
 */
export async function checkInstagramAccountHealth(
  igUserId: string,
  pageAccessToken: string,
): Promise<InstagramHealthResult> {
  try {
    const account = await graphGet<{ id: string; username?: string; account_type?: string }>(
      `/${igUserId}`,
      { fields: 'id,username,account_type', access_token: pageAccessToken },
    );
    if (account.account_type === 'PERSONAL') {
      return { status: 'personal_account' };
    }
    return { status: 'healthy', username: account.username };
  } catch (error) {
    if (error instanceof GraphApiError) {
      const body = error.body as { error?: { message?: string } } | undefined;
      return {
        status: 'unreachable',
        reason: body?.error?.message ?? `Graph API responded ${error.status}`,
      };
    }
    throw error;
  }
}

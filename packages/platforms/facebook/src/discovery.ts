import { graphGet } from './graphClient.js';

export interface FacebookPage {
  id: string;
  name: string;
  accessToken: string;
}

/**
 * Empty/partial results are expected, not an error: Pages living under a
 * Business Portfolio can be under-reported here even though a direct
 * GET /{page_id}?fields=access_token call works — SAAS_PLAN.md's confirmed
 * gotcha. Callers must treat an empty array as a normal outcome, not a failure,
 * and surface the manual-entry fallback (see ../server/modules/connections).
 */
export async function fetchUserPages(userAccessToken: string): Promise<FacebookPage[]> {
  const result = await graphGet<{
    data?: Array<{ id: string; name: string; access_token: string }>;
  }>('/me/accounts', { access_token: userAccessToken });
  return (result.data ?? []).map((page) => ({
    id: page.id,
    name: page.name,
    accessToken: page.access_token,
  }));
}

export interface InstagramBusinessAccount {
  id: string;
  username?: string;
}

export async function fetchPageInstagramAccount(
  pageId: string,
  pageAccessToken: string,
): Promise<InstagramBusinessAccount | null> {
  const result = await graphGet<{
    instagram_business_account?: { id: string; username?: string };
  }>(`/${pageId}`, {
    fields: 'instagram_business_account{id,username}',
    access_token: pageAccessToken,
  });
  return result.instagram_business_account ?? null;
}

export async function validatePageToken(
  pageId: string,
  accessToken: string,
): Promise<{ id: string; name: string } | null> {
  try {
    return await graphGet<{ id: string; name: string }>(`/${pageId}`, {
      fields: 'id,name',
      access_token: accessToken,
    });
  } catch {
    return null;
  }
}

export async function validateUserToken(accessToken: string): Promise<{ id: string } | null> {
  try {
    return await graphGet<{ id: string }>('/me', { access_token: accessToken });
  } catch {
    return null;
  }
}

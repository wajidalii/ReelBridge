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

// Kept structurally identical to @reelbridge/shared's InstagramDiscoveryOutcome
// (shared can't depend on this package, so it can't import this type directly)
// — if a variant is added here, add it there too, and in every catch(() => ({...}))
// fallback that constructs one (upsertFacebookTargets.ts, worker/healthCheck.ts).
export type InstagramDiscoveryResult =
  | { status: 'linked'; account: InstagramBusinessAccount }
  | { status: 'not_linked' }
  | { status: 'personal_account'; accountId: string };

/**
 * A Page's `instagram_business_account` link can keep pointing at an account
 * that was later switched back to Personal in the Instagram app without the
 * Page-side link being removed (TDD.md §1.2/§1.3: personal accounts must be
 * rejected at connection time, "validated via the Page-graph lookup") — so a
 * populated `instagram_business_account` field alone isn't proof the account
 * is still Business/Creator. account_type is checked with a follow-up call
 * and PERSONAL is rejected rather than treated as a usable target.
 */
export async function discoverPageInstagramAccount(
  pageId: string,
  pageAccessToken: string,
): Promise<InstagramDiscoveryResult> {
  const pageResult = await graphGet<{
    instagram_business_account?: { id: string; username?: string };
  }>(`/${pageId}`, {
    fields: 'instagram_business_account{id,username}',
    access_token: pageAccessToken,
  });
  const linked = pageResult.instagram_business_account;
  if (!linked) {
    return { status: 'not_linked' };
  }

  // No .catch(() => null) here: a failed account_type lookup must not fall
  // through to "linked", since that would silently accept a Personal account
  // whenever this specific call errors (rate limiting, a transient blip, a
  // deleted account) while the first call still succeeds. Letting the error
  // propagate means callers' existing catch-and-treat-as-not_linked fallback
  // (see upsertFacebookTargets.ts / healthCheck.ts) applies here too, so the
  // control fails closed rather than open.
  const accountDetails = await graphGet<{ account_type?: string }>(`/${linked.id}`, {
    fields: 'account_type',
    access_token: pageAccessToken,
  });

  if (accountDetails.account_type === 'PERSONAL') {
    return { status: 'personal_account', accountId: linked.id };
  }

  return { status: 'linked', account: { id: linked.id, username: linked.username } };
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

import { graphGet } from './graphClient.js';

/** Meta's documented ceiling for API-published posts per IG professional account per rolling 24h. */
export const INSTAGRAM_PUBLISHING_LIMIT_PER_24H = 100;

export interface ContentPublishingLimit {
  quotaUsage: number;
  quotaTotal: number;
}

/**
 * `GET /{ig-user-id}/content_publishing_limit` (issue #35, TDD.md §1.2).
 * Counts posts made through *any* API client for this account in the last
 * 24h, so it's the source of truth over ReelBridge's own local limiter.
 */
export async function fetchContentPublishingLimit(
  igUserId: string,
  accessToken: string,
): Promise<ContentPublishingLimit> {
  const result = await graphGet<{
    data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }>;
  }>(`/${igUserId}/content_publishing_limit`, {
    fields: 'quota_usage,config',
    access_token: accessToken,
  });
  const entry = result.data?.[0];
  return {
    quotaUsage: entry?.quota_usage ?? 0,
    quotaTotal: entry?.config?.quota_total ?? INSTAGRAM_PUBLISHING_LIMIT_PER_24H,
  };
}

export class InstagramPublishingLimitExceededError extends Error {
  readonly quotaUsage: number;
  readonly quotaTotal: number;

  constructor(quotaUsage: number, quotaTotal: number) {
    super(
      `Instagram content publishing limit reached (${quotaUsage}/${quotaTotal} in the last 24h)`,
    );
    this.name = 'InstagramPublishingLimitExceededError';
    this.quotaUsage = quotaUsage;
    this.quotaTotal = quotaTotal;
  }
}

/** Throws when the account has no headroom left; the worker defers the job rather than failing it. */
export async function assertPublishingHeadroom(
  igUserId: string,
  accessToken: string,
): Promise<void> {
  const limit = await fetchContentPublishingLimit(igUserId, accessToken);
  if (limit.quotaUsage >= limit.quotaTotal) {
    throw new InstagramPublishingLimitExceededError(limit.quotaUsage, limit.quotaTotal);
  }
}

export function isInstagramPublishingLimitError(error: unknown): boolean {
  return error instanceof InstagramPublishingLimitExceededError;
}

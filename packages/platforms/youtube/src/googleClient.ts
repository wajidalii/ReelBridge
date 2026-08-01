export const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

export class GoogleApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.body = body;
  }
}

const QUOTA_ERROR_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded']);

/**
 * `videos.insert` has its own dedicated daily quota bucket — 100 calls/day,
 * 1 unit each — separate from the shared 10,000-unit pool used by
 * reads/search (verified against Google's public quota-cost documentation,
 * https://developers.google.com/youtube/v3/determine_quota_cost, 2026-08-01;
 * TDD.md §5 risk 4 flags this as a fast-moving number that should be
 * re-verified against the project's own live Cloud Console quota dashboard
 * at deploy time too, not just public docs). Google reports exhausting it as
 * HTTP 403 with an `errors[].reason` of `quotaExceeded` (or the related
 * `dailyLimitExceeded`/`rateLimitExceeded`) rather than a distinct status
 * code, so detecting it means inspecting the error body shape.
 */
export function isQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof GoogleApiError) || error.status !== 403) return false;
  const body = error.body as { error?: { errors?: Array<{ reason?: string }> } } | undefined;
  const reasons = body?.error?.errors?.map((e) => e.reason) ?? [];
  return reasons.some((reason) => reason !== undefined && QUOTA_ERROR_REASONS.has(reason));
}

export async function googlePost<T>(url: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(params) });
  const body: unknown = await res.json();
  if (!res.ok) {
    throw new GoogleApiError(
      `Google API POST ${url} failed with status ${res.status}`,
      res.status,
      body,
    );
  }
  return body as T;
}

// Google/YouTube APIs take the access token as an Authorization header
// rather than a query param (unlike Facebook's Graph API), so this client
// shape intentionally differs from platform-facebook's graphGet.
export async function googleGet<T>(
  path: string,
  params: Record<string, string>,
  accessToken: string,
  base: string = YOUTUBE_API_BASE,
): Promise<T> {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body: unknown = await res.json();
  if (!res.ok) {
    throw new GoogleApiError(
      `YouTube API GET ${path} failed with status ${res.status}`,
      res.status,
      body,
    );
  }
  return body as T;
}

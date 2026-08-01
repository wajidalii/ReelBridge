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

export async function googlePost<T>(url: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(params) });
  const body: unknown = await res.json();
  if (!res.ok) {
    throw new GoogleApiError(`Google API POST ${url} failed with status ${res.status}`, res.status, body);
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
    throw new GoogleApiError(`YouTube API GET ${path} failed with status ${res.status}`, res.status, body);
  }
  return body as T;
}

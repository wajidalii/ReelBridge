import { GOOGLE_OAUTH_AUTH_URL, GOOGLE_OAUTH_TOKEN_URL, googlePost } from './googleClient.js';

/**
 * Narrowest sufficient scope for ReelBridge's use case (TDD.md §1.3): covers
 * upload only, deliberately not the broader `youtube` or `youtubepartner`
 * scopes which would require a heavier Google verification review.
 */
export const YOUTUBE_OAUTH_SCOPES = ['https://www.googleapis.com/auth/youtube.upload'] as const;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function buildGoogleOAuthUrl(config: GoogleOAuthConfig, state: string): string {
  const url = new URL(GOOGLE_OAUTH_AUTH_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', YOUTUBE_OAUTH_SCOPES.join(' '));
  // access_type=offline + prompt=consent together are what make Google
  // reissue a refresh_token on every grant, including a reconnect by a user
  // who already authorized before — without prompt=consent, Google only
  // returns refresh_token on the very first authorization for that user+app.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

export interface GoogleTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  scope?: string;
}

export async function exchangeCodeForTokens(
  config: GoogleOAuthConfig,
  code: string,
): Promise<GoogleTokenResult> {
  const result = await googlePost<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  }>(GOOGLE_OAUTH_TOKEN_URL, {
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  });
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresInSeconds: result.expires_in,
    scope: result.scope,
  };
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGoogleOAuthUrl,
  refreshAccessToken,
  YOUTUBE_OAUTH_SCOPES,
  type GoogleOAuthConfig,
} from './oauth.js';

const config: GoogleOAuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://api.example.com/api/connections/google/callback',
};

describe('buildGoogleOAuthUrl', () => {
  it('requests the narrow youtube.upload scope with offline access and forced consent', () => {
    const url = new URL(buildGoogleOAuthUrl(config, 'signed-state'));
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('scope')).toBe(YOUTUBE_OAUTH_SCOPES.join(' '));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
  });
});

describe('refreshAccessToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exchanges the connection-level refresh token for a fresh access token via grant_type=refresh_token', async () => {
    let capturedParams: URLSearchParams | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedParams = init?.body as URLSearchParams;
        return new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const result = await refreshAccessToken(config, 'stored-refresh-token');

    expect(result).toEqual({ accessToken: 'fresh-token', expiresInSeconds: 3600 });
    expect(capturedParams?.get('grant_type')).toBe('refresh_token');
    expect(capturedParams?.get('refresh_token')).toBe('stored-refresh-token');
    expect(capturedParams?.get('client_id')).toBe(config.clientId);
    expect(capturedParams?.get('client_secret')).toBe(config.clientSecret);
    expect(capturedParams?.has('redirect_uri')).toBe(false);
  });
});

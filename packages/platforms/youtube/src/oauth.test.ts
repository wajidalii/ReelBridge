import { describe, expect, it } from 'vitest';
import { buildGoogleOAuthUrl, YOUTUBE_OAUTH_SCOPES, type GoogleOAuthConfig } from './oauth.js';

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

import { graphGet } from './graphClient.js';

/**
 * "Facebook Login for Business" scopes, chosen so one connect flow surfaces
 * both Facebook Pages and any linked Instagram Business account (TDD.md §1.2)
 * rather than requiring a second, separate Instagram login for the common case.
 */
export const FACEBOOK_OAUTH_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'business_management',
  'instagram_basic',
  'instagram_content_publish',
] as const;

export interface FacebookOAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export function buildFacebookOAuthUrl(config: FacebookOAuthConfig, state: string): string {
  const url = new URL('https://www.facebook.com/v21.0/dialog/oauth');
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', FACEBOOK_OAUTH_SCOPES.join(','));
  return url.toString();
}

export async function exchangeCodeForShortLivedToken(
  config: FacebookOAuthConfig,
  code: string,
): Promise<string> {
  const result = await graphGet<{ access_token: string }>('/oauth/access_token', {
    client_id: config.appId,
    client_secret: config.appSecret,
    redirect_uri: config.redirectUri,
    code,
  });
  return result.access_token;
}

export interface LongLivedTokenResult {
  accessToken: string;
  expiresInSeconds?: number;
}

export async function exchangeForLongLivedToken(
  config: FacebookOAuthConfig,
  shortLivedToken: string,
): Promise<LongLivedTokenResult> {
  const result = await graphGet<{ access_token: string; expires_in?: number }>(
    '/oauth/access_token',
    {
      grant_type: 'fb_exchange_token',
      client_id: config.appId,
      client_secret: config.appSecret,
      fb_exchange_token: shortLivedToken,
    },
  );
  return { accessToken: result.access_token, expiresInSeconds: result.expires_in };
}

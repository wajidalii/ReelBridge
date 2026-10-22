import { GoogleApiError } from './googleClient.js';
import { refreshAccessToken, type GoogleOAuthConfig } from './oauth.js';

export type YouTubeHealthResult =
  | { status: 'healthy' }
  | { status: 'revoked'; reason: string }
  | { status: 'unreachable'; reason: string };

/**
 * Health check for a youtube_channel target (issue #36): the only credential
 * is the connection-level refresh token, and the only way to know it still
 * works is to use it. Google reports a revoked/expired refresh token as
 * HTTP 400 `invalid_grant` — a definitive "needs reconnect", distinct from a
 * transient 5xx which just means "check again later".
 */
export async function checkYouTubeConnectionHealth(
  config: Pick<GoogleOAuthConfig, 'clientId' | 'clientSecret'>,
  refreshToken: string,
): Promise<YouTubeHealthResult> {
  try {
    await refreshAccessToken(config, refreshToken);
    return { status: 'healthy' };
  } catch (error) {
    if (error instanceof GoogleApiError) {
      const body = error.body as { error?: string; error_description?: string } | undefined;
      if (error.status === 400 || error.status === 401) {
        return {
          status: 'revoked',
          reason: body?.error_description ?? body?.error ?? `Google responded ${error.status}`,
        };
      }
      return { status: 'unreachable', reason: `Google responded ${error.status}` };
    }
    throw error;
  }
}

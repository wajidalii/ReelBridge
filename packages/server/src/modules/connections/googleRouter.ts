import { randomUUID } from 'node:crypto';
import {
  buildGoogleOAuthUrl,
  exchangeCodeForTokens,
  fetchUserChannels,
  type GoogleOAuthConfig,
} from '@reelbridge/platform-youtube';
import { Router, type Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { signOAuthState, verifyOAuthState } from './oauthState.js';
import { upsertGoogleConnection } from './upsertGoogleConnection.js';

function loadGoogleOAuthConfig(): GoogleOAuthConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET environment variables are not set');
  }
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ??
    `${process.env.API_BASE_URL ?? 'http://localhost:4000'}/api/connections/google/callback`;
  return { clientId, clientSecret, redirectUri };
}

function clientConnectGoogleUrl(): string {
  const clientOrigin = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '');
  return `${clientOrigin}/connect/youtube`;
}

function redirectWithError(res: Response, clientUrl: string, message: string): void {
  const params = new URLSearchParams({ error: message });
  res.redirect(`${clientUrl}?${params.toString()}`);
}

export const googleConnectionsRouter = Router();

googleConnectionsRouter.get('/start', requireAuth, (req, res) => {
  const config = loadGoogleOAuthConfig();
  const state = signOAuthState({
    userId: req.userId!,
    nonce: randomUUID(),
    platform: 'google',
    intent: 'youtube',
  });
  res.redirect(buildGoogleOAuthUrl(config, state));
});

// Google navigates the user's browser here directly (not an XHR the client's
// JS could intercept), so this must issue an HTTP redirect back to a client
// page rather than return raw JSON — including on unexpected failures, hence
// the try/catch around the whole token-exchange/discovery/upsert flow below
// rather than relying on the app-wide JSON error handler.
googleConnectionsRouter.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const clientUrl = clientConnectGoogleUrl();

  if (error) {
    redirectWithError(res, clientUrl, `Google OAuth error: ${String(error)}`);
    return;
  }
  if (typeof code !== 'string' || typeof state !== 'string') {
    redirectWithError(res, clientUrl, 'Missing code or state');
    return;
  }

  let statePayload;
  try {
    statePayload = verifyOAuthState(state);
  } catch {
    redirectWithError(res, clientUrl, 'Invalid or expired state');
    return;
  }
  if (statePayload.platform !== 'google') {
    redirectWithError(res, clientUrl, 'Invalid state');
    return;
  }

  try {
    const config = loadGoogleOAuthConfig();
    const tokens = await exchangeCodeForTokens(config, code);
    const channels = await fetchUserChannels(tokens.accessToken);
    const result = await upsertGoogleConnection(
      statePayload.userId,
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresInSeconds,
      tokens.scope,
      channels,
    );

    const params = new URLSearchParams({
      connected: '1',
      channels: String(result.channels.length),
    });
    res.redirect(`${clientUrl}?${params.toString()}`);
  } catch (err) {
    console.error('Google OAuth callback failed after code exchange:', err);
    redirectWithError(
      res,
      clientUrl,
      'Something went wrong connecting to Google. Please try again.',
    );
  }
});

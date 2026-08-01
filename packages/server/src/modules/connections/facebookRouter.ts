import { randomUUID } from 'node:crypto';
import {
  buildFacebookOAuthUrl,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  fetchUserPages,
  type FacebookOAuthConfig,
} from '@reelbridge/platform-facebook';
import { Router, type Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { signOAuthState, verifyOAuthState } from './oauthState.js';
import { upsertFacebookConnection } from './upsertFacebookTargets.js';

function loadFacebookOAuthConfig(): FacebookOAuthConfig {
  const appId = process.env.FB_APP_ID;
  const appSecret = process.env.FB_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('FB_APP_ID/FB_APP_SECRET environment variables are not set');
  }
  const redirectUri =
    process.env.FB_OAUTH_REDIRECT_URI ??
    `${process.env.API_BASE_URL ?? 'http://localhost:4000'}/api/connections/facebook/callback`;
  return { appId, appSecret, redirectUri };
}

function clientConnectFacebookUrl(): string {
  const clientOrigin = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '');
  return `${clientOrigin}/connect/facebook`;
}

function redirectWithError(
  res: Response,
  clientUrl: string,
  message: string,
  intent?: 'facebook' | 'instagram' | 'youtube',
): void {
  const params = new URLSearchParams({ error: message });
  if (intent) params.set('intent', intent);
  res.redirect(`${clientUrl}?${params.toString()}`);
}

export const facebookConnectionsRouter = Router();

facebookConnectionsRouter.get('/start', requireAuth, (req, res) => {
  const config = loadFacebookOAuthConfig();
  const intent = req.query.intent === 'instagram' ? 'instagram' : 'facebook';
  const state = signOAuthState({
    userId: req.userId!,
    nonce: randomUUID(),
    platform: 'facebook',
    intent,
  });
  res.redirect(buildFacebookOAuthUrl(config, state));
});

// Facebook navigates the user's browser here directly (not an XHR the
// client's JS could intercept), so this must issue an HTTP redirect back to
// a client page rather than return raw JSON — including on unexpected
// failures, hence the try/catch around the whole token-exchange/upsert flow
// below rather than relying on the app-wide JSON error handler.
facebookConnectionsRouter.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const clientUrl = clientConnectFacebookUrl();

  if (error) {
    redirectWithError(res, clientUrl, `Facebook OAuth error: ${String(error)}`);
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
  if (statePayload.platform !== 'facebook') {
    redirectWithError(res, clientUrl, 'Invalid state', statePayload.intent);
    return;
  }

  try {
    const config = loadFacebookOAuthConfig();
    const shortLivedToken = await exchangeCodeForShortLivedToken(config, code);
    const { accessToken: longLivedToken, expiresInSeconds } = await exchangeForLongLivedToken(
      config,
      shortLivedToken,
    );

    const pages = await fetchUserPages(longLivedToken);
    const result = await upsertFacebookConnection(
      statePayload.userId,
      longLivedToken,
      expiresInSeconds,
      pages,
    );

    // Per SAAS_PLAN.md's confirmed Business Portfolio gotcha: zero pages found
    // is a normal, non-error outcome — the manual-entry fallback covers it.
    const params = new URLSearchParams({
      connected: '1',
      intent: statePayload.intent,
      pages: String(result.pages.length),
      instagram: String(result.instagramTargets.length),
    });
    res.redirect(`${clientUrl}?${params.toString()}`);
  } catch (err) {
    console.error('Facebook OAuth callback failed after code exchange:', err);
    redirectWithError(
      res,
      clientUrl,
      'Something went wrong connecting to Facebook. Please try again.',
      statePayload.intent,
    );
  }
});

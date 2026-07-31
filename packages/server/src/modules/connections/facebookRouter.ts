import { randomUUID } from 'node:crypto';
import {
  buildFacebookOAuthUrl,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  fetchUserPages,
  type FacebookOAuthConfig,
} from '@reelbridge/platform-facebook';
import { Router } from 'express';
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

export const facebookConnectionsRouter = Router();

facebookConnectionsRouter.get('/start', requireAuth, (req, res) => {
  const config = loadFacebookOAuthConfig();
  const state = signOAuthState({ userId: req.userId!, nonce: randomUUID(), platform: 'facebook' });
  res.redirect(buildFacebookOAuthUrl(config, state));
});

facebookConnectionsRouter.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    res.status(400).json({ error: `Facebook OAuth error: ${String(error)}` });
    return;
  }
  if (typeof code !== 'string' || typeof state !== 'string') {
    res.status(400).json({ error: 'Missing code or state' });
    return;
  }

  let statePayload;
  try {
    statePayload = verifyOAuthState(state);
  } catch {
    res.status(400).json({ error: 'Invalid or expired state' });
    return;
  }
  if (statePayload.platform !== 'facebook') {
    res.status(400).json({ error: 'Invalid state' });
    return;
  }

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

  res.json({
    connected: true,
    pagesFound: result.pages.length,
    instagramAccountsFound: result.instagramTargets.length,
    pages: result.pages,
    instagramTargets: result.instagramTargets,
    // Per SAAS_PLAN.md's confirmed Business Portfolio gotcha: zero pages found
    // is a normal, non-error outcome — the manual-entry fallback covers it.
    note:
      result.pages.length === 0
        ? 'No Pages were auto-detected. This can happen for Pages under a Business Portfolio — use manual entry below.'
        : undefined,
  });
});

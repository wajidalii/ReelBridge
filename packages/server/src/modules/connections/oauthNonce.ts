import type { Request, Response } from 'express';

/**
 * The signed `state` already proves the callback was minted by this server
 * for a given user, but not that the *browser* presenting it is that user's.
 * Without this, an attacker could start the flow on their own account, hand
 * the resulting provider URL to a victim, and have the victim's Page/channel
 * land in the attacker's ReelBridge account (login-CSRF on the connection).
 * Binding the nonce to a short-lived cookie closes that: the callback only
 * proceeds when the cookie matches the nonce inside the state.
 */
const NONCE_TTL_MS = 10 * 60 * 1000;

function cookieName(provider: 'facebook' | 'google'): string {
  return `reelbridge_oauth_${provider}`;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Lax, not Strict: the provider redirects the browser back here as a
    // top-level navigation, which Strict would strip the cookie from.
    sameSite: 'lax' as const,
    path: '/api/connections',
  };
}

export function setOAuthNonceCookie(res: Response, provider: 'facebook' | 'google', nonce: string) {
  res.cookie(cookieName(provider), nonce, { ...cookieOptions(), maxAge: NONCE_TTL_MS });
}

export function readOAuthNonceCookie(
  req: Request,
  provider: 'facebook' | 'google',
): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[cookieName(provider)];
  return typeof value === 'string' ? value : undefined;
}

export function clearOAuthNonceCookie(res: Response, provider: 'facebook' | 'google') {
  res.clearCookie(cookieName(provider), cookieOptions());
}

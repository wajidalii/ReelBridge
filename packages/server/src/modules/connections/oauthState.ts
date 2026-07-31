import jwt from 'jsonwebtoken';

export interface OAuthStatePayload {
  userId: string;
  nonce: string;
  platform: 'facebook' | 'google';
}

function loadJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set');
  }
  return secret;
}

/** Short-lived signed state embedding userId+nonce — CSRF protection for the OAuth redirect round-trip. */
export function signOAuthState(payload: OAuthStatePayload): string {
  return jwt.sign(payload, loadJwtSecret(), { expiresIn: '10m' });
}

export function verifyOAuthState(token: string): OAuthStatePayload {
  return jwt.verify(token, loadJwtSecret()) as OAuthStatePayload;
}

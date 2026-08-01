import jwt from 'jsonwebtoken';

export interface OAuthStatePayload {
  userId: string;
  nonce: string;
  platform: 'facebook' | 'google';
  /**
   * What the user actually clicked ("Connect Facebook" vs "Connect Instagram") —
   * both drive the same Facebook Login for Business flow, so this rides along in
   * the signed state to survive the redirect round-trip and let the callback tell
   * the client which success/error copy to show. 'youtube' is the sole intent
   * for the Google flow (Google OAuth only ever leads to YouTube discovery).
   */
  intent: 'facebook' | 'instagram' | 'youtube';
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

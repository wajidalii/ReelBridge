import jwt from 'jsonwebtoken';

const ACCESS_TOKEN_TTL = '15m';

interface AccessTokenPayload {
  sub: string;
}

function loadJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set');
  }
  return secret;
}

const ISSUER = 'reelbridge';
const AUDIENCE = 'reelbridge-api';

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId } satisfies AccessTokenPayload, loadJwtSecret(), {
    expiresIn: ACCESS_TOKEN_TTL,
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

/**
 * Algorithm, issuer and audience are pinned: an OAuth `state` JWT (signed
 * with the same secret, see connections/oauthState.ts) must never be
 * accepted as a session token, and `alg` is never taken from the token.
 */
export function verifyAccessToken(token: string): { userId: string } {
  const payload = jwt.verify(token, loadJwtSecret(), {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  }) as AccessTokenPayload;
  if (typeof payload.sub !== 'string') {
    throw new Error('Access token has no subject');
  }
  return { userId: payload.sub };
}

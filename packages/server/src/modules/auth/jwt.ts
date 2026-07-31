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

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId } satisfies AccessTokenPayload, loadJwtSecret(), {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

export function verifyAccessToken(token: string): { userId: string } {
  const payload = jwt.verify(token, loadJwtSecret()) as AccessTokenPayload;
  return { userId: payload.sub };
}

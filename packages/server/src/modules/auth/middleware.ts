import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from './jwt.js';
import { ACCESS_TOKEN_COOKIE } from './cookies.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[ACCESS_TOKEN_COOKIE] as string | undefined;
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const { userId } = verifyAccessToken(token);
    req.userId = userId;
    next();
  } catch {
    res.status(401).json({ error: 'Not authenticated' });
  }
}

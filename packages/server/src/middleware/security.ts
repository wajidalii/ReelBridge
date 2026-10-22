import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function allowedOrigins(): Set<string> {
  const raw = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
  return new Set(
    raw
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return allowedOrigins().has(origin.replace(/\/+$/, ''));
}

/**
 * CSRF defence-in-depth for cookie-based auth. SameSite=Lax already stops a
 * cross-site form POST from carrying the session cookie in modern browsers,
 * but Lax has exceptions (top-level navigations, older browsers), so every
 * state-changing request must also come from an allowed origin. Browsers
 * always send `Origin` on cross-origin and same-origin POSTs made by fetch/
 * XHR, and `Sec-Fetch-Site` on everything; a request with neither header is
 * a non-browser client (curl, supertest) which can't be a CSRF victim.
 */
export function requireTrustedOrigin(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  if (origin !== undefined) {
    if (isAllowedOrigin(origin)) {
      next();
      return;
    }
    res.status(403).json({ error: 'Cross-site request rejected' });
    return;
  }
  if (fetchSite === 'cross-site') {
    res.status(403).json({ error: 'Cross-site request rejected' });
    return;
  }
  next();
}

/** Default headers; CSP is left to the client host (Vite/CDN) since the API only serves JSON. */
export const securityHeaders = helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
});

const isTest = process.env.NODE_ENV === 'test';

/**
 * Credential endpoints get a tight per-IP budget (brute-force / credential
 * stuffing), everything else a generous one that only trips on abuse.
 * Limits are disabled under NODE_ENV=test so integration suites that hammer
 * /login from one address don't start seeing 429s.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT_PER_15M ?? 20),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: { error: 'Too many attempts, please try again later' },
});

export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? 300),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: { error: 'Too many requests, please slow down' },
});

/** Uploads are expensive on both ends; cap how many batches one IP can start per hour. */
export const uploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.UPLOAD_RATE_LIMIT_PER_HOUR ?? 60),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: { error: 'Too many uploads, please try again later' },
});

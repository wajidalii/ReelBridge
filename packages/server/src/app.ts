// Patches Express 4's Router so a rejected promise in an async route handler is
// forwarded to error-handling middleware, instead of hanging the client forever
// (found the hard way: a rethrown error inside an async handler with no catch-all
// just left the request unanswered — see #17's DELETE /api/media/:id fix).
import 'express-async-errors';
import { randomUUID } from 'node:crypto';
import { getLogger, getPool, getRedisConnection, metricsRegistry } from '@reelbridge/shared';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { pinoHttp } from 'pino-http';
import {
  apiRateLimiter,
  isAllowedOrigin,
  requireTrustedOrigin,
  securityHeaders,
} from './middleware/security.js';
import { authRouter } from './modules/auth/router.js';
import { batchesRouter } from './modules/batches/batchesRouter.js';
import { billingRouter } from './modules/billing/billingRouter.js';
import { usageLimitErrorHandler } from './modules/billing/middleware.js';
import { configRouter } from './modules/config/configRouter.js';
import { connectionsRouter } from './modules/connections/connectionsRouter.js';
import { facebookConnectionsRouter } from './modules/connections/facebookRouter.js';
import { facebookTargetsRouter } from './modules/connections/facebookTargetsRouter.js';
import { googleConnectionsRouter } from './modules/connections/googleRouter.js';
import { dashboardRouter } from './modules/dashboard/dashboardRouter.js';
import { mediaRouter } from './modules/media/mediaRouter.js';
import { ownershipErrorHandler } from './modules/ownership/middleware.js';
import { postsRouter } from './modules/posts/postsRouter.js';
import { targetsRouter } from './modules/targets/targetsRouter.js';

export interface CreateAppOptions {
  /** Request logging is noise in integration tests; on by default otherwise. */
  requestLogging?: boolean;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const log = getLogger();

  // Behind a load balancer / reverse proxy in production: needed for
  // req.ip (rate limiting) and `secure` cookie detection to see the real
  // client rather than the proxy. Set TRUST_PROXY=1 (hop count) or a CIDR.
  if (process.env.TRUST_PROXY) {
    const value = process.env.TRUST_PROXY;
    app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value);
  }
  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(
    cors({
      origin: (origin, callback) => {
        // Non-browser clients send no Origin; browsers from an unknown origin
        // get no CORS headers (and no credentials), which the browser then blocks.
        if (!origin || isAllowedOrigin(origin)) callback(null, true);
        else callback(null, false);
      },
      credentials: true,
    }),
  );

  const requestLogging = options.requestLogging ?? process.env.NODE_ENV !== 'test';
  if (requestLogging) {
    app.use(
      pinoHttp({
        logger: log,
        genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
        autoLogging: { ignore: (req) => req.url === '/api/health' || req.url === '/api/metrics' },
        customLogLevel: (_req, res, err) =>
          err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      }),
    );
  }

  // Multipart uploads are handled by multer on their own route; everything
  // else is small JSON. A 1MB cap bounds what a client can make the parser
  // hold in memory per request (captions for a 50-target assignment fit easily).
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Liveness: the process is up. Readiness: its dependencies answer.
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/api/ready', async (_req, res) => {
    const checks: Record<string, 'ok' | 'error'> = { database: 'error', redis: 'error' };
    await Promise.all([
      getPool()
        .query('SELECT 1')
        .then(() => {
          checks.database = 'ok';
        })
        .catch(() => {}),
      getRedisConnection()
        .ping()
        .then(() => {
          checks.redis = 'ok';
        })
        .catch(() => {}),
    ]);
    const ready = Object.values(checks).every((value) => value === 'ok');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', checks });
  });

  // Prometheus scrape endpoint (issue #39). Not under the rate limiter —
  // scrapers poll frequently — and optionally bearer-protected since the
  // default-metrics include process details.
  app.get('/api/metrics', async (req, res) => {
    const token = process.env.METRICS_BEARER_TOKEN;
    if (token && req.get('authorization') !== `Bearer ${token}`) {
      res.status(401).send('unauthorized');
      return;
    }
    res.set('Content-Type', metricsRegistry.contentType);
    res.send(await metricsRegistry.metrics());
  });

  app.use('/api', apiRateLimiter);
  app.use('/api', requireTrustedOrigin);

  app.use('/api/config', configRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/connections/facebook', facebookConnectionsRouter);
  app.use('/api/connections/google', googleConnectionsRouter);
  app.use('/api/connections', connectionsRouter);
  app.use('/api/targets/facebook', facebookTargetsRouter);
  app.use('/api/targets', targetsRouter);
  app.use('/api/media', mediaRouter);
  app.use('/api/batches', batchesRouter);
  app.use('/api/posts', postsRouter);
  app.use('/api/dashboard', dashboardRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(ownershipErrorHandler);
  app.use(usageLimitErrorHandler);
  // Final catch-all: anything a specific error handler didn't recognize gets a
  // generic 500 rather than leaking internals (or, pre-express-async-errors,
  // hanging the client forever).
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    // Body parser / multer errors carry an HTTP status — surface those as-is
    // (413 payload too large, 400 malformed JSON) instead of a misleading 500.
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? Number((error as { status: unknown }).status)
        : undefined;
    if (status && status >= 400 && status < 500) {
      if (!res.headersSent) {
        res.status(status).json({
          error: error instanceof Error ? error.message : 'Bad request',
        });
      }
      return;
    }
    log.error(
      { err: error, reqId: (req as Request & { id?: string }).id },
      'unhandled request error',
    );
    console.error('Unhandled request error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}

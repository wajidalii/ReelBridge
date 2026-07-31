// Patches Express 4's Router so a rejected promise in an async route handler is
// forwarded to error-handling middleware, instead of hanging the client forever
// (found the hard way: a rethrown error inside an async handler with no catch-all
// just left the request unanswered — see #17's DELETE /api/media/:id fix).
import 'express-async-errors';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { authRouter } from './modules/auth/router.js';
import { batchesRouter } from './modules/batches/batchesRouter.js';
import { configRouter } from './modules/config/configRouter.js';
import { facebookConnectionsRouter } from './modules/connections/facebookRouter.js';
import { facebookTargetsRouter } from './modules/connections/facebookTargetsRouter.js';
import { mediaRouter } from './modules/media/mediaRouter.js';
import { ownershipErrorHandler } from './modules/ownership/middleware.js';
import { targetsRouter } from './modules/targets/targetsRouter.js';

export function createApp() {
  const app = express();

  app.use(
    cors({ origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173', credentials: true }),
  );
  app.use(express.json());
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/config', configRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/connections/facebook', facebookConnectionsRouter);
  app.use('/api/targets/facebook', facebookTargetsRouter);
  app.use('/api/targets', targetsRouter);
  app.use('/api/media', mediaRouter);
  app.use('/api/batches', batchesRouter);

  app.use(ownershipErrorHandler);

  // Final catch-all: anything a specific error handler didn't recognize gets a
  // generic 500 rather than leaking internals (or, pre-express-async-errors,
  // hanging the client forever).
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled request error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { authRouter } from './modules/auth/router.js';
import { facebookConnectionsRouter } from './modules/connections/facebookRouter.js';
import { facebookTargetsRouter } from './modules/connections/facebookTargetsRouter.js';
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

  app.use('/api/auth', authRouter);
  app.use('/api/connections/facebook', facebookConnectionsRouter);
  app.use('/api/targets/facebook', facebookTargetsRouter);
  app.use('/api/targets', targetsRouter);

  app.use(ownershipErrorHandler);

  return app;
}

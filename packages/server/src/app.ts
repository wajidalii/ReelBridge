import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { authRouter } from './modules/auth/router.js';

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

  return app;
}

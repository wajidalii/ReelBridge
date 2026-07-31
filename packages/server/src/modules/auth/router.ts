import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { clearAuthCookies, REFRESH_TOKEN_COOKIE, setAuthCookies } from './cookies.js';
import { signAccessToken } from './jwt.js';
import { hashPassword, verifyPassword } from './password.js';
import { requireAuth } from './middleware.js';
import {
  findValidRefreshToken,
  issueRefreshToken,
  revokeRefreshTokenById,
  revokeRefreshTokenByRawToken,
} from './refreshTokens.js';

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const authRouter = Router();

authRouter.post('/signup', async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid email or password (min 8 characters)' });
    return;
  }
  const { email, password } = parsed.data;
  const db = getDb();

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    res.status(409).json({ error: 'Email already in use' });
    return;
  }

  const passwordHash = await hashPassword(password);
  const [user] = await db.insert(users).values({ email, passwordHash }).returning();
  if (!user) {
    res.status(500).json({ error: 'Failed to create user' });
    return;
  }

  const accessToken = signAccessToken(user.id);
  const refreshToken = await issueRefreshToken(user.id);
  setAuthCookies(res, accessToken, refreshToken);

  res.status(201).json({ id: user.id, email: user.email });
});

authRouter.post('/login', async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid email or password' });
    return;
  }
  const { email, password } = parsed.data;

  const [user] = await getDb().select().from(users).where(eq(users.email, email));
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const accessToken = signAccessToken(user.id);
  const refreshToken = await issueRefreshToken(user.id);
  setAuthCookies(res, accessToken, refreshToken);

  res.json({ id: user.id, email: user.email });
});

authRouter.post('/logout', async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE] as string | undefined;
  if (refreshToken) {
    await revokeRefreshTokenByRawToken(refreshToken);
  }
  clearAuthCookies(res);
  res.status(204).send();
});

authRouter.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE] as string | undefined;
  if (!refreshToken) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const valid = await findValidRefreshToken(refreshToken);
  if (!valid) {
    clearAuthCookies(res);
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  // Rotation: the presented refresh token is single-use — revoke it and issue a new one.
  await revokeRefreshTokenById(valid.id);
  const accessToken = signAccessToken(valid.userId);
  const newRefreshToken = await issueRefreshToken(valid.userId);
  setAuthCookies(res, accessToken, newRefreshToken);

  res.status(204).send();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const [user] = await getDb()
    .select({ id: users.id, email: users.email, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, req.userId!));

  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  res.json(user);
});

import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { getDb, getLogger, users } from '@reelbridge/shared';
import { authRateLimiter } from '../../middleware/security.js';
import { ensureDefaultSubscription } from '../billing/checkUsageLimit.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../email/index.js';
import { consumeAuthToken, issueAuthToken } from './authTokens.js';
import { clearAuthCookies, REFRESH_TOKEN_COOKIE, setAuthCookies } from './cookies.js';
import { signAccessToken } from './jwt.js';
import { hashPassword, verifyPassword } from './password.js';
import { requireAuth } from './middleware.js';
import {
  findValidRefreshToken,
  issueRefreshToken,
  revokeAllRefreshTokensForUser,
  revokeRefreshTokenById,
  revokeRefreshTokenByRawToken,
} from './refreshTokens.js';
import { isSignupAllowed, signupMode } from './signupGating.js';

// bcrypt silently truncates at 72 bytes; capping well under that keeps the
// whole password significant and bounds hashing cost per request.
const passwordSchema = z.string().min(8).max(64);
const emailSchema = z.string().trim().toLowerCase().email().max(320);

const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  invite_code: z.string().trim().max(128).optional(),
});
const credentialsSchema = z.object({ email: emailSchema, password: z.string().min(1).max(64) });

// A real bcrypt hash of a throwaway string: login compares against this when
// the email doesn't exist so the response time doesn't reveal which emails
// are registered.
const DUMMY_PASSWORD_HASH_PROMISE = hashPassword('reelbridge-dummy-password-for-timing');

export const authRouter = Router();

async function issueSession(res: Parameters<typeof setAuthCookies>[0], userId: string) {
  const accessToken = signAccessToken(userId);
  const refreshToken = await issueRefreshToken(userId);
  setAuthCookies(res, accessToken, refreshToken);
}

function publicUser(user: { id: string; email: string; emailVerifiedAt: Date | null }) {
  return { id: user.id, email: user.email, emailVerified: user.emailVerifiedAt !== null };
}

authRouter.post('/signup', authRateLimiter, async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid email or password (8-64 characters)' });
    return;
  }
  const { email, password, invite_code: inviteCode } = parsed.data;

  if (!isSignupAllowed(email, inviteCode)) {
    res.status(403).json({
      error: 'ReelBridge is currently invite-only. Enter a valid invite code to create an account.',
      code: 'invite_required',
    });
    return;
  }

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

  await ensureDefaultSubscription(user.id);

  // Verification email is best-effort: a provider outage must not block
  // signup, and the user can request a resend from the app.
  try {
    const token = await issueAuthToken(user.id, 'email_verification');
    await sendVerificationEmail(user.email, token);
  } catch (error) {
    getLogger().error({ err: error, userId: user.id }, 'failed to send verification email');
  }

  await issueSession(res, user.id);
  res.status(201).json(publicUser(user));
});

authRouter.post('/login', authRateLimiter, async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid email or password' });
    return;
  }
  const { email, password } = parsed.data;
  const [user] = await getDb().select().from(users).where(eq(users.email, email));

  const matches = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, await DUMMY_PASSWORD_HASH_PROMISE).then(() => false);
  if (!user || !matches) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  await issueSession(res, user.id);
  res.json(publicUser(user));
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
  await issueSession(res, valid.userId);
  res.status(204).send();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const [user] = await getDb()
    .select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, req.userId!));
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  res.json({ ...publicUser(user), createdAt: user.createdAt });
});

// --- email verification (issue #38) ---------------------------------------

const tokenSchema = z.object({ token: z.string().min(1).max(512) });

authRouter.post('/verify-email', authRateLimiter, async (req, res) => {
  const parsed = tokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  const consumed = await consumeAuthToken(parsed.data.token, 'email_verification');
  if (!consumed) {
    res.status(400).json({ error: 'This verification link is invalid or has expired.' });
    return;
  }
  await getDb()
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(users.id, consumed.userId));
  res.json({ verified: true });
});

authRouter.post('/resend-verification', requireAuth, authRateLimiter, async (req, res) => {
  const [user] = await getDb().select().from(users).where(eq(users.id, req.userId!));
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (user.emailVerifiedAt) {
    res.json({ sent: false, alreadyVerified: true });
    return;
  }
  const token = await issueAuthToken(user.id, 'email_verification');
  await sendVerificationEmail(user.email, token);
  res.json({ sent: true });
});

// --- password reset (issue #38) --------------------------------------------

authRouter.post('/forgot-password', authRateLimiter, async (req, res) => {
  const parsed = z.object({ email: emailSchema }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  const [user] = await getDb().select().from(users).where(eq(users.email, parsed.data.email));
  if (user) {
    try {
      const token = await issueAuthToken(user.id, 'password_reset');
      await sendPasswordResetEmail(user.email, token);
    } catch (error) {
      getLogger().error({ err: error, userId: user.id }, 'failed to send password reset email');
    }
  }
  // Identical response whether or not the address exists.
  res.json({ message: 'If an account exists for that email, a reset link has been sent.' });
});

authRouter.post('/reset-password', authRateLimiter, async (req, res) => {
  const parsed = z
    .object({ token: z.string().min(1).max(512), password: passwordSchema })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'token and a new password (8-64 characters) are required' });
    return;
  }
  const consumed = await consumeAuthToken(parsed.data.token, 'password_reset');
  if (!consumed) {
    res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    return;
  }
  const passwordHash = await hashPassword(parsed.data.password);
  await getDb().update(users).set({ passwordHash }).where(eq(users.id, consumed.userId));
  // Every existing session dies with the old password.
  await revokeAllRefreshTokensForUser(consumed.userId);
  clearAuthCookies(res);
  res.json({ reset: true });
});

/** Lets the signup form know whether to ask for an invite code. */
authRouter.get('/signup-policy', (_req, res) => {
  res.json({ mode: signupMode() });
});

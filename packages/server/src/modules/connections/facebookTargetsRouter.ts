import { encrypt, getDb, publishTargets } from '@reelbridge/shared';
import { validatePageToken } from '@reelbridge/platform-facebook';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { checkUsageLimit } from '../billing/checkUsageLimit.js';
import { getOrCreateManualFacebookConnection } from './manualFacebookTarget.js';

const manualTargetSchema = z.object({
  // Numeric IDs in practice, but Graph API also accepts Page usernames in the
  // path; the character class just keeps the value a single safe path segment.
  page_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, 'Invalid Page ID'),
  name: z.string().trim().min(1).max(200),
  access_token: z.string().trim().min(1).max(2048),
});

export const facebookTargetsRouter = Router();

facebookTargetsRouter.post('/manual', requireAuth, async (req, res) => {
  const parsed = manualTargetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'page_id, name, and access_token are required' });
    return;
  }
  const { page_id: pageId, name, access_token: accessToken } = parsed.data;

  await checkUsageLimit(req.userId!, 'connect_target');

  const validated = await validatePageToken(pageId, accessToken);
  if (!validated) {
    res.status(400).json({
      error:
        'Could not validate this Page ID/access token against the Graph API. It may be invalid, expired, or missing the required permissions.',
    });
    return;
  }

  const connectionId = await getOrCreateManualFacebookConnection(req.userId!);
  const encryptedToken = encrypt(accessToken);
  const displayName = validated.name || name;

  const [target] = await getDb()
    .insert(publishTargets)
    .values({
      userId: req.userId!,
      platformConnectionId: connectionId,
      platform: 'facebook_page',
      externalId: pageId,
      displayName,
      accessTokenCiphertext: encryptedToken.ciphertext,
      accessTokenIv: encryptedToken.iv,
      accessTokenTag: encryptedToken.tag,
      tokenSource: 'manual',
      lastValidatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [publishTargets.userId, publishTargets.platform, publishTargets.externalId],
      set: {
        displayName,
        accessTokenCiphertext: encryptedToken.ciphertext,
        accessTokenIv: encryptedToken.iv,
        accessTokenTag: encryptedToken.tag,
        tokenSource: 'manual',
        isActive: true,
        lastValidatedAt: new Date(),
      },
    })
    .returning();

  if (!target) {
    res.status(500).json({ error: 'Failed to save target' });
    return;
  }

  res.status(201).json({ id: target.id, externalId: pageId, displayName });
});

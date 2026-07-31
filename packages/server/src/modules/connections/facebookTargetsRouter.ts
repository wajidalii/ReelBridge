import { encrypt } from '@reelbridge/shared';
import { validatePageToken } from '@reelbridge/platform-facebook';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { publishTargets } from '../../db/schema.js';
import { requireAuth } from '../auth/middleware.js';
import { getOrCreateManualFacebookConnection } from './manualFacebookTarget.js';

const manualTargetSchema = z.object({
  page_id: z.string().min(1),
  name: z.string().min(1),
  access_token: z.string().min(1),
});

export const facebookTargetsRouter = Router();

facebookTargetsRouter.post('/manual', requireAuth, async (req, res) => {
  const parsed = manualTargetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'page_id, name, and access_token are required' });
    return;
  }
  const { page_id: pageId, name, access_token: accessToken } = parsed.data;

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

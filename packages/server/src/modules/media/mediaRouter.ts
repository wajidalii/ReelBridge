import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import {
  buildMediaStorageKey,
  createStorageAdapterFromEnv,
  getDb,
  mediaAssets,
} from '@reelbridge/shared';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../auth/middleware.js';
import { assertMediaAssetOwnership } from '../ownership/assertOwnership.js';
import { requireOwnership } from '../ownership/middleware.js';
import { probeVideoMetadata, type VideoMetadata } from './ffprobe.js';

/** Business limit enforced per-file below (not at the multer layer) so one oversized/wrong-type file doesn't abort the whole batch. */
const MAX_FILE_SIZE_BYTES = Number(process.env.MEDIA_MAX_FILE_SIZE_BYTES ?? 500 * 1024 * 1024);
/** Hard safety-net cap at the multer layer only, well above the business limit. */
const MULTER_HARD_CAP_BYTES = 2 * 1024 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, callback) => callback(null, `${randomUUID()}-${file.originalname}`),
  }),
  limits: { fileSize: MULTER_HARD_CAP_BYTES },
});

export const mediaRouter = Router();

interface CreatedMedia {
  id: string;
  originalFilename: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

interface FailedUpload {
  originalFilename: string;
  error: string;
}

mediaRouter.post('/', requireAuth, upload.array('files'), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: 'No files uploaded (expected multipart field "files")' });
    return;
  }

  const storage = createStorageAdapterFromEnv();
  const db = getDb();
  const created: CreatedMedia[] = [];
  const failed: FailedUpload[] = [];

  for (const file of files) {
    try {
      if (!file.originalname.toLowerCase().endsWith('.mp4')) {
        failed.push({ originalFilename: file.originalname, error: 'Only .mp4 files are accepted' });
        continue;
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        failed.push({
          originalFilename: file.originalname,
          error: `File exceeds the ${MAX_FILE_SIZE_BYTES} byte size limit`,
        });
        continue;
      }

      const metadata: VideoMetadata = await probeVideoMetadata(file.path).catch(() => ({}));
      const mediaAssetId = randomUUID();
      const storageKey = buildMediaStorageKey(req.userId!, mediaAssetId);

      await storage.save(storageKey, fs.createReadStream(file.path), 'video/mp4');

      const [inserted] = await db
        .insert(mediaAssets)
        .values({
          id: mediaAssetId,
          userId: req.userId!,
          originalFilename: file.originalname,
          storageKey,
          fileSizeBytes: file.size,
          durationSeconds: metadata.durationSeconds,
          width: metadata.width,
          height: metadata.height,
          status: 'validated',
        })
        .returning();

      if (inserted) {
        created.push({
          id: inserted.id,
          originalFilename: inserted.originalFilename,
          durationSeconds: inserted.durationSeconds ?? undefined,
          width: inserted.width ?? undefined,
          height: inserted.height ?? undefined,
        });
      }
    } catch (error) {
      failed.push({
        originalFilename: file.originalname,
        error: error instanceof Error ? error.message : 'Upload failed',
      });
    } finally {
      await fs.promises.unlink(file.path).catch(() => {});
    }
  }

  res.status(created.length > 0 ? 201 : 400).json({ created, failed });
});

mediaRouter.get(
  '/:id',
  requireAuth,
  requireOwnership('id', assertMediaAssetOwnership),
  async (req, res) => {
    const db = getDb();
    const [asset] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, req.params.id as string));

    if (!asset) {
      res.status(404).json({ error: 'Media asset not found' });
      return;
    }
    res.json(asset);
  },
);

/**
 * drizzle-orm wraps the raw pg error in DrizzleQueryError, with the real
 * error (carrying Postgres's error `code`) under `.cause` — check both, since
 * the wrapping isn't guaranteed to be consistent across drivers/versions.
 */
function isForeignKeyViolation(error: unknown): boolean {
  function codeOf(value: unknown): unknown {
    if (typeof value === 'object' && value !== null && 'code' in value) {
      return (value as { code: unknown }).code;
    }
    return undefined;
  }

  if (codeOf(error) === '23503') {
    return true;
  }
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return codeOf((error as { cause: unknown }).cause) === '23503';
  }
  return false;
}

mediaRouter.delete(
  '/:id',
  requireAuth,
  requireOwnership('id', assertMediaAssetOwnership),
  async (req, res) => {
    const db = getDb();
    const id = req.params.id as string;

    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id));
    if (!asset) {
      res.status(404).json({ error: 'Media asset not found' });
      return;
    }

    try {
      await db.delete(mediaAssets).where(eq(mediaAssets.id, id));
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        res.status(409).json({ error: 'This media asset is used in a post and cannot be deleted' });
        return;
      }
      throw error;
    }

    await createStorageAdapterFromEnv()
      .delete(asset.storageKey)
      .catch(() => {});
    res.status(204).send();
  },
);

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import {
  buildMediaStorageKey,
  createStorageAdapterFromEnv,
  getDb,
  mediaAssets,
  type ValidationWarning,
} from '@reelbridge/shared';
import { desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { uploadRateLimiter } from '../../middleware/security.js';
import { requireAuth } from '../auth/middleware.js';
import { PREVIEW_ADAPTERS_BY_PLATFORM } from '../batches/platformAdapters.js';
import { assertMediaAssetOwnership } from '../ownership/assertOwnership.js';
import { requireOwnership } from '../ownership/middleware.js';
import { probeVideoMetadata, type VideoMetadata } from './ffprobe.js';

/** Business limit enforced per-file below (not at the multer layer) so one oversized/wrong-type file doesn't abort the whole batch. */
const MAX_FILE_SIZE_BYTES = Number(process.env.MEDIA_MAX_FILE_SIZE_BYTES ?? 500 * 1024 * 1024);
/** Hard safety-net cap at the multer layer only, well above the business limit. */
const MULTER_HARD_CAP_BYTES = 2 * 1024 * 1024 * 1024;

/** Max files in one multipart request; the UI uploads in batches anyway. */
const MAX_FILES_PER_REQUEST = 20;

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    // Never derive the temp filename from the client-supplied name: multer
    // path.joins it under the destination, so a crafted originalname like
    // `../../x.mp4` could write outside tmpdir. The original name is kept
    // separately in the DB row (the caption-matching feature needs it) —
    // it just never touches the filesystem.
    filename: (_req, _file, callback) => callback(null, `${randomUUID()}.upload`),
  }),
  limits: { fileSize: MULTER_HARD_CAP_BYTES, files: MAX_FILES_PER_REQUEST, fields: 50 },
});

/** Keeps the stored display name sane: strips any path component and control characters, bounds length. */
function sanitizeOriginalFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'upload.mp4').slice(0, 255);
}

export const mediaRouter = Router();

interface CreatedMedia {
  id: string;
  originalFilename: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  clientId?: string;
}

interface FailedUpload {
  originalFilename: string;
  error: string;
  clientId?: string;
}

/**
 * A client may attach multiple files with the same originalFilename in one
 * request — correlating the response back to UI rows by filename alone is
 * ambiguous if some of those duplicates succeed and others fail. An optional
 * `client_ids` field (one value per `files` entry, same order) lets a caller
 * correlate exactly instead; both multer's `req.files` and busboy's parsed
 * `req.body.client_ids` preserve the order fields appeared in the multipart
 * stream, so index-matching the two is safe as long as the caller sends them
 * in matching pairs.
 */
function normalizeToStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

mediaRouter.get('/', requireAuth, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters' });
    return;
  }
  const rows = await getDb()
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.userId, req.userId!))
    .orderBy(desc(mediaAssets.uploadedAt))
    .limit(parsed.data.limit ?? 50)
    .offset(parsed.data.offset ?? 0);
  res.json(rows);
});

mediaRouter.post('/', requireAuth, uploadRateLimiter, upload.array('files'), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: 'No files uploaded (expected multipart field "files")' });
    return;
  }
  const clientIds = normalizeToStringArray((req.body as Record<string, unknown>).client_ids);

  const storage = createStorageAdapterFromEnv();
  const db = getDb();
  const created: CreatedMedia[] = [];
  const failed: FailedUpload[] = [];

  for (const [index, file] of files.entries()) {
    const clientId = clientIds[index];
    const originalFilename = sanitizeOriginalFilename(file.originalname);
    try {
      if (!originalFilename.toLowerCase().endsWith('.mp4')) {
        failed.push({ originalFilename, error: 'Only .mp4 files are accepted', clientId });
        continue;
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        failed.push({
          originalFilename,
          error: `File exceeds the ${MAX_FILE_SIZE_BYTES} byte size limit`,
          clientId,
        });
        continue;
      }

      // The extension is client-controlled; ffprobe is the real content
      // check. Anything ffprobe can't parse as a video stream is rejected
      // rather than stored and handed to a platform that will fail later.
      let metadata: VideoMetadata;
      try {
        metadata = await probeVideoMetadata(file.path);
      } catch {
        failed.push({ originalFilename, error: 'File is not a readable video', clientId });
        continue;
      }
      if (!metadata.hasVideoStream) {
        failed.push({ originalFilename, error: 'File contains no video stream', clientId });
        continue;
      }
      const mediaAssetId = randomUUID();
      const storageKey = buildMediaStorageKey(req.userId!, mediaAssetId);

      await storage.save(storageKey, fs.createReadStream(file.path), 'video/mp4');

      const [inserted] = await db
        .insert(mediaAssets)
        .values({
          id: mediaAssetId,
          userId: req.userId!,
          originalFilename,
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
          clientId,
        });
      }
    } catch (error) {
      failed.push({
        originalFilename,
        error: error instanceof Error ? error.message : 'Upload failed',
        clientId,
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

// Lets the batch upload UI show per-platform constraint warnings on a video
// as soon as it's uploaded (design.md §4), before the user has assigned any
// targets — unlike the batch preview endpoint (#20), which only produces
// warnings for (item, target) pairs that already exist.
mediaRouter.get(
  '/:id/constraints',
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

    const mediaRef = {
      mediaAssetId: asset.id,
      storageKey: asset.storageKey,
      originalFilename: asset.originalFilename,
      fileSizeBytes: asset.fileSizeBytes,
      durationSeconds: asset.durationSeconds ?? undefined,
      width: asset.width ?? undefined,
      height: asset.height ?? undefined,
    };

    const warningsByPlatform: Record<string, ValidationWarning[]> = {};
    for (const [platform, adapter] of Object.entries(PREVIEW_ADAPTERS_BY_PLATFORM)) {
      if (adapter) {
        warningsByPlatform[platform] = adapter.validateMediaConstraints(mediaRef);
      }
    }

    res.json({ mediaAssetId: asset.id, warningsByPlatform });
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

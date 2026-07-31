import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import {
  mediaAssets,
  postBatches,
  postItems,
  postTargets,
  publishTargets,
} from '../../db/schema.js';

/**
 * Thrown by every assert*Ownership check below. Maps to a 404 response (see
 * ./middleware.ts), not 403 — a 403 would confirm the resource exists but
 * belongs to someone else, leaking its existence to a tenant who shouldn't
 * even know that much. 404 is indistinguishable from "never existed".
 */
export class ResourceNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = 'ResourceNotFoundError';
  }
}

export async function assertTargetOwnership(
  userId: string,
  publishTargetId: string,
): Promise<void> {
  const [row] = await getDb()
    .select({ id: publishTargets.id })
    .from(publishTargets)
    .where(and(eq(publishTargets.id, publishTargetId), eq(publishTargets.userId, userId)))
    .limit(1);
  if (!row) {
    throw new ResourceNotFoundError('Target');
  }
}

export async function assertMediaAssetOwnership(
  userId: string,
  mediaAssetId: string,
): Promise<void> {
  const [row] = await getDb()
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, mediaAssetId), eq(mediaAssets.userId, userId)))
    .limit(1);
  if (!row) {
    throw new ResourceNotFoundError('Media asset');
  }
}

export async function assertBatchOwnership(userId: string, batchId: string): Promise<void> {
  const [row] = await getDb()
    .select({ id: postBatches.id })
    .from(postBatches)
    .where(and(eq(postBatches.id, batchId), eq(postBatches.userId, userId)))
    .limit(1);
  if (!row) {
    throw new ResourceNotFoundError('Batch');
  }
}

/** post_items has no direct user_id column — ownership flows through its batch. */
export async function assertPostItemOwnership(userId: string, postItemId: string): Promise<void> {
  const [row] = await getDb()
    .select({ id: postItems.id })
    .from(postItems)
    .innerJoin(postBatches, eq(postItems.batchId, postBatches.id))
    .where(and(eq(postItems.id, postItemId), eq(postBatches.userId, userId)))
    .limit(1);
  if (!row) {
    throw new ResourceNotFoundError('Post item');
  }
}

/** post_targets has no direct user_id column either — ownership flows through post_item -> batch. */
export async function assertPostTargetOwnership(
  userId: string,
  postTargetId: string,
): Promise<void> {
  const [row] = await getDb()
    .select({ id: postTargets.id })
    .from(postTargets)
    .innerJoin(postItems, eq(postTargets.postItemId, postItems.id))
    .innerJoin(postBatches, eq(postItems.batchId, postBatches.id))
    .where(and(eq(postTargets.id, postTargetId), eq(postBatches.userId, userId)))
    .limit(1);
  if (!row) {
    throw new ResourceNotFoundError('Post target');
  }
}

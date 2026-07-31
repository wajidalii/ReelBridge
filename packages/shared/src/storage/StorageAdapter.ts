import type { Readable } from 'node:stream';

/**
 * Abstraction over S3-compatible object storage. The same interface is
 * satisfied by MinIO in dev and real S3/R2 in production — both speak the S3
 * API, so there is one implementation (S3StorageAdapter), just pointed at a
 * different endpoint via env config, rather than a separate local-disk adapter
 * that wouldn't work once there's more than one app/worker instance.
 */
export interface StorageAdapter {
  save(key: string, body: Readable | Buffer, contentType?: string): Promise<void>;
  read(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  /**
   * The only path to a publicly fetchable URL for an otherwise-private object.
   * Needed for Instagram's container-publish flow, which requires Meta's
   * servers to fetch the video from a URL rather than accept a binary upload.
   */
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
}

export function buildMediaStorageKey(userId: string, mediaAssetId: string): string {
  return `${userId}/${mediaAssetId}.mp4`;
}

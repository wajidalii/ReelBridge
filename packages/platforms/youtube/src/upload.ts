import { GoogleApiError } from './googleClient.js';

const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/videos';

// Google requires resumable chunk sizes to be a multiple of 256 KiB; 8 MiB
// keeps the number of round-trips reasonable for typical Reels-length clips
// without holding an excessive number of chunks in flight.
const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_ATTEMPTS_PER_CHUNK = 3;

export interface VideoMetadata {
  title: string;
  description: string;
  privacyStatus: 'private' | 'public' | 'unlisted';
  /** RFC3339 timestamp. YouTube's native scheduling (TDD.md §1.3): the video
   *  uploads immediately as `private`, and YouTube itself flips it to its
   *  target visibility at this time. */
  publishAt?: string;
  categoryId?: string;
}

/**
 * Phase 1: opens a resumable upload session (`uploadType=resumable`) and
 * returns the session URI to PUT chunks to. The video's metadata (title,
 * description, privacy/schedule) is set here, in the same call, not after
 * the upload finishes — mirroring how Facebook's adapter sets its caption
 * and scheduling in one flow.
 */
export async function initiateResumableUpload(
  accessToken: string,
  fileSizeBytes: number,
  metadata: VideoMetadata,
): Promise<string> {
  const body = {
    snippet: {
      title: metadata.title,
      description: metadata.description,
      categoryId: metadata.categoryId ?? '22',
    },
    status: {
      privacyStatus: metadata.privacyStatus,
      ...(metadata.publishAt ? { publishAt: metadata.publishAt } : {}),
      selfDeclaredMadeForKids: false,
    },
  };

  const res = await fetch(`${UPLOAD_ENDPOINT}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(fileSizeBytes),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const responseBody: unknown = await res.json().catch(() => undefined);
    throw new GoogleApiError(
      `Failed to initiate YouTube resumable upload session (status ${res.status})`,
      res.status,
      responseBody,
    );
  }
  const location = res.headers.get('location');
  if (!location) {
    throw new GoogleApiError(
      'YouTube did not return a resumable upload session URI',
      res.status,
      undefined,
    );
  }
  return location;
}

export interface UploadedVideo {
  id: string;
}

// A 308 "Resume Incomplete" response's Range header looks like "bytes=0-12345"
// — the upper bound is the last byte index YouTube has durably received.
function parseReceivedBytes(rangeHeader: string | null): number {
  if (!rangeHeader) return 0;
  const match = /bytes=0-(\d+)/.exec(rangeHeader);
  return match ? Number(match[1]) + 1 : 0;
}

type UploadProgress = { done: true; video: UploadedVideo } | { done: false; offset: number };

/**
 * Queries how many bytes of a resumable session YouTube has actually
 * received, per Google's resumable upload protocol: an empty PUT with a
 * Content-Range header whose range is an asterisk (meaning "unknown range,
 * just tell me the total"). Used after a transient chunk-upload failure so a
 * retry resumes from YouTube's actual state rather than assuming the failed
 * request either fully landed or fully didn't — a partial write on Google's
 * end would otherwise cause bytes to be skipped or duplicated.
 */
async function queryUploadProgress(
  uploadUrl: string,
  accessToken: string,
  fileSizeBytes: number,
): Promise<UploadProgress> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Range': `bytes */${fileSizeBytes}`,
    },
  });
  if (res.status === 308) {
    return { done: false, offset: parseReceivedBytes(res.headers.get('range')) };
  }
  if (res.ok) {
    const video = (await res.json()) as UploadedVideo;
    return { done: true, video };
  }
  const body: unknown = await res.json().catch(() => undefined);
  throw new GoogleApiError(
    `Failed to query YouTube upload progress (status ${res.status})`,
    res.status,
    body,
  );
}

/**
 * Phase 2: uploads the video in fixed-size chunks against the session URI
 * from initiateResumableUpload. On a transient failure (network error, 5xx),
 * retries up to MAX_ATTEMPTS_PER_CHUNK times, re-querying YouTube's actual
 * received-bytes offset before each retry rather than blindly re-sending the
 * same range.
 */
export async function uploadVideoChunks(
  uploadUrl: string,
  accessToken: string,
  buffer: Buffer,
  fileSizeBytes: number,
): Promise<UploadedVideo> {
  let offset = 0;
  let attempt = 0;

  while (offset < fileSizeBytes) {
    const end = Math.min(offset + CHUNK_SIZE, fileSizeBytes);
    const chunk = buffer.subarray(offset, end);

    try {
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${offset}-${end - 1}/${fileSizeBytes}`,
        },
        body: chunk,
      });

      if (res.status === 308) {
        offset = parseReceivedBytes(res.headers.get('range')) || end;
        attempt = 0;
        continue;
      }
      if (res.ok) {
        return (await res.json()) as UploadedVideo;
      }
      const body: unknown = await res.json().catch(() => undefined);
      throw new GoogleApiError(
        `YouTube chunk upload failed (status ${res.status})`,
        res.status,
        body,
      );
    } catch (err) {
      attempt += 1;
      if (attempt >= MAX_ATTEMPTS_PER_CHUNK) throw err;
      const progress = await queryUploadProgress(uploadUrl, accessToken, fileSizeBytes);
      if (progress.done) return progress.video;
      offset = progress.offset;
    }
  }

  throw new GoogleApiError('YouTube upload finished without a final response', 0, undefined);
}

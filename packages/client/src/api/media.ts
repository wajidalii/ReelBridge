import type { ValidationWarning } from '@reelbridge/shared';
import { apiGet } from './client.js';

export interface CreatedMedia {
  id: string;
  originalFilename: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  clientId?: string;
}

export interface FailedUpload {
  originalFilename: string;
  error: string;
  clientId?: string;
}

interface UploadMediaResponse {
  created: CreatedMedia[];
  failed: FailedUpload[];
}

export interface UploadableFile {
  file: File;
  /** Echoed back per created/failed entry so results can be matched to a row
   *  by id rather than by filename, which is ambiguous when two files in the
   *  same request share a name and don't share the same outcome. */
  clientId: string;
}

/**
 * Raw XHR rather than fetch (used everywhere else): fetch has no upload
 * progress event, and per-file progress is one of #23's acceptance criteria.
 */
export function uploadMediaFiles(
  files: UploadableFile[],
  onProgress: (fraction: number) => void,
): Promise<UploadMediaResponse> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    // Appended in matching pairs so the server can index-correlate the two
    // fields — multer/busboy preserve per-field order, not cross-field order.
    for (const { file, clientId } of files) {
      formData.append('files', file);
      formData.append('client_ids', clientId);
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/media');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error('Upload failed: the server returned an invalid response.'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as UploadMediaResponse);
      } else {
        const message =
          body && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : `Upload failed with status ${xhr.status}.`;
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error.'));
    xhr.send(formData);
  });
}

export interface MediaConstraintsResponse {
  mediaAssetId: string;
  warningsByPlatform: Record<string, ValidationWarning[]>;
}

export function fetchMediaConstraints(mediaAssetId: string): Promise<MediaConstraintsResponse> {
  return apiGet<MediaConstraintsResponse>(`/media/${mediaAssetId}/constraints`);
}

/**
 * Captures a frame from the file already sitting in the browser as a
 * thumbnail — no server-side thumbnail generation exists, and the file is
 * available locally before/during upload anyway, so there's no reason to
 * wait on a round-trip for this.
 */
export function generateVideoThumbnail(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;

    let settled = false;
    const cleanup = () => URL.revokeObjectURL(objectUrl);
    // Some browsers can stall mid-decode without ever firing loadedmetadata,
    // seeked, or error — a timeout guarantees the object URL is still
    // revoked and the row falls back to "no preview" instead of hanging.
    const timeoutId = window.setTimeout(() => finish(undefined), 5000);
    function finish(result: string | undefined) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      cleanup();
      resolve(result);
    }

    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(0.1, (video.duration || 0) / 2);
    });
    video.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx || canvas.width === 0 || canvas.height === 0) {
          finish(undefined);
          return;
        }
        ctx.drawImage(video, 0, 0);
        finish(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        finish(undefined);
      }
    });
    video.addEventListener('error', () => finish(undefined));
  });
}

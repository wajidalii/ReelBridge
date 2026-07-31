import { GraphApiError, graphPost } from './graphClient.js';

export interface StartUploadResult {
  videoId: string;
  uploadUrl: string;
}

/**
 * Phase 1 of the validated 3-phase /video_reels flow (SAAS_PLAN.md,
 * hand-tested against the real Graph API for CureVera): kicks off an upload
 * session for a Page and gets back a video_id + upload_url to POST the binary to.
 */
export async function startVideoReelsUpload(
  pageId: string,
  pageAccessToken: string,
): Promise<StartUploadResult> {
  const result = await graphPost<{ video_id: string; upload_url: string }>(
    `/${pageId}/video_reels`,
    {
      upload_phase: 'start',
      access_token: pageAccessToken,
    },
  );
  return { videoId: result.video_id, uploadUrl: result.upload_url };
}

/**
 * Phase 2: raw binary POST to the upload_url from phase 1, authenticated via
 * an `Authorization: OAuth {token}` header (not a query param, and not the
 * standard `Bearer` scheme) plus `offset`/`file_size` headers — the exact
 * shape validated by hand against the real Graph API.
 */
export async function uploadVideoBinary(
  uploadUrl: string,
  pageAccessToken: string,
  video: Buffer,
  fileSizeBytes: number,
): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${pageAccessToken}`,
      offset: '0',
      file_size: String(fileSizeBytes),
    },
    body: video,
  });
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new GraphApiError(
      `Facebook video binary upload failed with status ${res.status}`,
      res.status,
      body,
    );
  }
}

export type FacebookVideoState = 'PUBLISHED' | 'SCHEDULED' | 'DRAFT';

export interface FinishUploadParams {
  pageId: string;
  pageAccessToken: string;
  videoId: string;
  description: string;
  videoState: FacebookVideoState;
  /** Unix timestamp (seconds). Required when videoState is 'SCHEDULED'. */
  scheduledPublishTimeUnix?: number;
}

/**
 * Phase 3: finalizes the upload, setting the caption and whether/when it
 * publishes. video_state=SCHEDULED + scheduled_publish_time is Facebook's
 * native scheduling — the platform itself holds and executes the future
 * publish, unlike Instagram's app-managed scheduling (TDD.md §1.2/§5).
 */
export async function finishVideoReelsUpload(params: FinishUploadParams): Promise<void> {
  const body: Record<string, string> = {
    upload_phase: 'finish',
    access_token: params.pageAccessToken,
    video_id: params.videoId,
    description: params.description,
    video_state: params.videoState,
  };
  if (params.scheduledPublishTimeUnix !== undefined) {
    body.scheduled_publish_time = String(params.scheduledPublishTimeUnix);
  }
  await graphPost(`/${params.pageId}/video_reels`, body);
}

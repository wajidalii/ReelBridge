import { PLATFORM_CAPABILITIES } from '@reelbridge/shared';
import type {
  CaptionPayload,
  MediaAssetRef,
  PlatformAdapter,
  PublishResult,
  StatusResult,
  TargetDescriptor,
  ValidationWarning,
} from '@reelbridge/shared';
import { graphGet } from './graphClient.js';
import {
  finishVideoReelsUpload,
  startVideoReelsUpload,
  uploadVideoBinary,
  type FacebookVideoState,
} from './upload.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

export class FacebookScheduleWindowError extends Error {}

/**
 * Enforces the confirmed 10min-29day Facebook scheduling window (SAAS_PLAN.md)
 * client-side, before ever calling the Graph API, using the adapter's own
 * declared capabilities rather than hardcoding the numbers a second time.
 */
function assertWithinSchedulingWindow(scheduledAt: Date): void {
  const { minScheduleLeadMinutes, maxScheduleLeadDays } = PLATFORM_CAPABILITIES.facebook_page;
  const now = Date.now();
  const scheduledMs = scheduledAt.getTime();

  if (minScheduleLeadMinutes !== null) {
    const minAt = now + minScheduleLeadMinutes * MS_PER_MINUTE;
    if (scheduledMs < minAt) {
      throw new FacebookScheduleWindowError(
        `scheduledAt must be at least ${minScheduleLeadMinutes} minutes in the future`,
      );
    }
  }
  if (maxScheduleLeadDays !== null) {
    const maxAt = now + maxScheduleLeadDays * MS_PER_DAY;
    if (scheduledMs > maxAt) {
      throw new FacebookScheduleWindowError(
        `scheduledAt must be at most ${maxScheduleLeadDays} days in the future`,
      );
    }
  }
}

/**
 * TargetDescriptor (packages/shared) has no access-token field, so the caller
 * (the worker's publish-to-target processor) is responsible for decrypting the
 * target's stored token and the media asset's bytes, and passing both through
 * via `metadata` — documented here since the interface itself can't express it.
 */
export interface FacebookPublishMetadata {
  accessToken: string;
  media: { buffer: Buffer };
}

function requireFacebookMetadata(target: TargetDescriptor): FacebookPublishMetadata {
  const metadata = target.metadata as Partial<FacebookPublishMetadata> | undefined;
  if (!metadata || typeof metadata.accessToken !== 'string' || !metadata.media?.buffer) {
    throw new Error(
      'target.metadata.{accessToken, media.buffer} are required to publish to a Facebook Page',
    );
  }
  return metadata as FacebookPublishMetadata;
}

export const facebookPageAdapter: PlatformAdapter = {
  platform: 'facebook_page',
  capabilities: PLATFORM_CAPABILITIES.facebook_page,

  discoverTargets(): Promise<TargetDescriptor[]> {
    // Real discovery happens via the OAuth callback (server modules/connections),
    // which has direct DB + decrypted-token access this generic entry point
    // doesn't; not wired to any route in this codebase.
    return Promise.reject(
      new Error(
        'discoverTargets is not implemented for a bare connectionId; use the OAuth connect flow.',
      ),
    );
  },

  async publish(
    target: TargetDescriptor,
    mediaAsset: MediaAssetRef,
    captionPayload: CaptionPayload,
    scheduledAt?: Date,
  ): Promise<PublishResult> {
    const { accessToken: pageAccessToken, media } = requireFacebookMetadata(target);

    if (scheduledAt) {
      assertWithinSchedulingWindow(scheduledAt);
    }

    const { videoId, uploadUrl } = await startVideoReelsUpload(target.externalId, pageAccessToken);
    await uploadVideoBinary(uploadUrl, pageAccessToken, media.buffer, mediaAsset.fileSizeBytes);

    const videoState: FacebookVideoState = scheduledAt ? 'SCHEDULED' : 'PUBLISHED';
    await finishVideoReelsUpload({
      pageId: target.externalId,
      pageAccessToken,
      videoId,
      description: captionPayload.caption,
      videoState,
      scheduledPublishTimeUnix: scheduledAt ? Math.floor(scheduledAt.getTime() / 1000) : undefined,
    });

    return {
      platformPostId: videoId,
      status: scheduledAt ? 'native_scheduled' : 'published',
    };
  },

  async checkStatus(target: TargetDescriptor, platformPostId: string): Promise<StatusResult> {
    const metadata = target.metadata as Partial<FacebookPublishMetadata> | undefined;
    if (!metadata || typeof metadata.accessToken !== 'string') {
      throw new Error('target.metadata.accessToken is required to check Facebook video status');
    }

    const result = await graphGet<{
      status?: { video_status?: string };
      permalink_url?: string;
    }>(`/${platformPostId}`, {
      fields: 'status,permalink_url',
      access_token: metadata.accessToken,
    });

    const videoStatus = result.status?.video_status;
    if (videoStatus === 'published' || videoStatus === 'ready') {
      return { status: 'published', permalinkUrl: result.permalink_url };
    }
    if (videoStatus === 'error') {
      return { status: 'failed', errorMessage: 'Facebook reported an error status for this video' };
    }
    return { status: 'pending' };
  },

  validateMediaConstraints(mediaAsset: MediaAssetRef): ValidationWarning[] {
    const warnings: ValidationWarning[] = [];

    if (
      mediaAsset.durationSeconds !== undefined &&
      (mediaAsset.durationSeconds < 4 || mediaAsset.durationSeconds > 90)
    ) {
      warnings.push({
        code: 'duration_out_of_range',
        message: `Facebook Reels must be 4-90 seconds; this video is ${mediaAsset.durationSeconds}s.`,
      });
    }
    if (mediaAsset.width && mediaAsset.height && mediaAsset.width > mediaAsset.height) {
      warnings.push({
        code: 'non_vertical_aspect_ratio',
        message: 'Facebook Reels are recommended to be vertical (9:16); this video is landscape.',
      });
    }
    return warnings;
  },
};

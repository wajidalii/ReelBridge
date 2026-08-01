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
import {
  createMediaContainer,
  fetchPermalink,
  publishContainer,
  waitForContainerFinished,
} from './container.js';

/**
 * TargetDescriptor (packages/shared) has no token fields, so the caller (the
 * worker's publish processor) is responsible for resolving the access token
 * and passing it through via `metadata`. Unlike Facebook/YouTube, Instagram
 * doesn't accept a raw binary body at all (TDD.md §1.2) — Meta's servers
 * pull the video from `videoUrl`, so there's no media buffer here, only a
 * short-lived signed URL the caller generated via `StorageAdapter.getSignedUrl`.
 *
 * The access token itself is the *linked Facebook Page's* token, not a
 * separate Instagram-specific one — instagram_business publish_targets rows
 * stay tokenless (shared/instagramTargets.ts), matching how IG content
 * publishing is actually authenticated against the Meta Graph API.
 */
export interface InstagramPublishMetadata {
  accessToken: string;
  videoUrl: string;
}

function requireInstagramMetadata(target: TargetDescriptor): InstagramPublishMetadata {
  const metadata = target.metadata as Partial<InstagramPublishMetadata> | undefined;
  if (
    !metadata ||
    typeof metadata.accessToken !== 'string' ||
    typeof metadata.videoUrl !== 'string'
  ) {
    throw new Error(
      'target.metadata.{accessToken, videoUrl} are required to publish to an Instagram Business account',
    );
  }
  return metadata as InstagramPublishMetadata;
}

export const instagramBusinessAdapter: PlatformAdapter = {
  platform: 'instagram_business',
  capabilities: PLATFORM_CAPABILITIES.instagram_business,

  discoverTargets(): Promise<TargetDescriptor[]> {
    // Real discovery happens off the Facebook connection (server modules/
    // connections/upsertFacebookTargets.ts), which has direct DB access this
    // generic entry point doesn't; not wired to any route in this codebase.
    return Promise.reject(
      new Error(
        'discoverTargets is not implemented for a bare connectionId; Instagram targets are discovered via the Facebook OAuth connect flow.',
      ),
    );
  },

  /**
   * Container-based publish (TDD.md §1.2): create → poll until FINISHED →
   * publish, all in one call. Unlike Facebook/YouTube's native scheduling
   * (upload now, let the platform hold the future publish moment),
   * Instagram has no such parameter — a container simply expires 24h after
   * creation, so this method always results in an actual, immediate publish
   * by the time it resolves. `scheduledAt` is intentionally unused here:
   * Instagram "scheduling" is entirely about *when this method gets called*
   * (the app-managed due-job wakeup worker, #34), not anything passed to
   * Meta's API itself.
   */
  async publish(
    target: TargetDescriptor,
    _mediaAsset: MediaAssetRef,
    captionPayload: CaptionPayload,
  ): Promise<PublishResult> {
    const { accessToken, videoUrl } = requireInstagramMetadata(target);

    const { creationId } = await createMediaContainer(
      target.externalId,
      accessToken,
      videoUrl,
      captionPayload.caption,
    );
    await waitForContainerFinished(creationId, accessToken);
    const { mediaId } = await publishContainer(target.externalId, accessToken, creationId);
    const permalinkUrl = await fetchPermalink(mediaId, accessToken);

    return { platformPostId: mediaId, status: 'published', permalinkUrl };
  },

  async checkStatus(): Promise<StatusResult> {
    // Never actually invoked in this codebase's call paths: pollStatus.ts
    // only polls rows still 'native_scheduled', and Instagram rows never
    // reach that status (publish() above is synchronous — by the time it
    // resolves, the post is already published or has thrown). Kept as a
    // stub for interface completeness rather than left mock-backed.
    return { status: 'published' };
  },

  validateMediaConstraints(mediaAsset: MediaAssetRef): ValidationWarning[] {
    const warnings: ValidationWarning[] = [];

    // Instagram Reels: 3-90 seconds (Meta's documented range as of this
    // writing — re-verify against live docs at real-adapter implementation
    // time, same caveat already flagged for YouTube's quota numbers in
    // TDD.md §1.3).
    if (
      mediaAsset.durationSeconds !== undefined &&
      (mediaAsset.durationSeconds < 3 || mediaAsset.durationSeconds > 90)
    ) {
      warnings.push({
        code: 'duration_out_of_range',
        severity: 'blocking',
        affectedField: 'duration',
        message: `Instagram Reels must be 3-90 seconds; this video is ${mediaAsset.durationSeconds}s.`,
      });
    }
    if (mediaAsset.width && mediaAsset.height && mediaAsset.width > mediaAsset.height) {
      warnings.push({
        code: 'non_vertical_aspect_ratio',
        severity: 'warning',
        affectedField: 'aspectRatio',
        message: 'Instagram Reels are recommended to be vertical (9:16); this video is landscape.',
      });
    }
    return warnings;
  },
};

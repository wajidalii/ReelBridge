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
import type { GoogleOAuthConfig } from './oauth.js';
import { refreshAccessToken } from './oauth.js';
import { initiateResumableUpload, uploadVideoChunks } from './upload.js';

/**
 * TargetDescriptor (packages/shared) has no token fields, so the caller (the
 * worker's publish-to-target processor) is responsible for decrypting the
 * *connection's* refresh token (not a per-target one — publish_targets stays
 * tokenless for youtube_channel rows, see upsertGoogleConnection.ts) and the
 * media asset's bytes, and passing both through via `metadata`.
 */
export interface YouTubePublishMetadata {
  refreshToken: string;
  oauthConfig: Pick<GoogleOAuthConfig, 'clientId' | 'clientSecret'>;
  media: { buffer: Buffer };
}

function requireYouTubeMetadata(target: TargetDescriptor): YouTubePublishMetadata {
  const metadata = target.metadata as Partial<YouTubePublishMetadata> | undefined;
  if (
    !metadata ||
    typeof metadata.refreshToken !== 'string' ||
    !metadata.oauthConfig?.clientId ||
    !metadata.oauthConfig?.clientSecret ||
    !metadata.media?.buffer
  ) {
    throw new Error(
      'target.metadata.{refreshToken, oauthConfig, media.buffer} are required to publish to a YouTube channel',
    );
  }
  return metadata as YouTubePublishMetadata;
}

export const youtubeChannelAdapter: PlatformAdapter = {
  platform: 'youtube_channel',
  capabilities: PLATFORM_CAPABILITIES.youtube_channel,

  discoverTargets(): Promise<TargetDescriptor[]> {
    // Real discovery happens via the Google OAuth callback (server modules/
    // connections), which has direct DB + decrypted-token access this
    // generic entry point doesn't; not wired to any route in this codebase.
    return Promise.reject(
      new Error(
        'discoverTargets is not implemented for a bare connectionId; use the Google OAuth connect flow.',
      ),
    );
  },

  async publish(
    target: TargetDescriptor,
    mediaAsset: MediaAssetRef,
    captionPayload: CaptionPayload,
    scheduledAt?: Date,
  ): Promise<PublishResult> {
    const { refreshToken, oauthConfig, media } = requireYouTubeMetadata(target);

    // Fresh access token per upload rather than reusing one that may already
    // be stale by the time a queued job actually runs (Google access tokens
    // last ~1h; refresh tokens don't expire on their own).
    const { accessToken } = await refreshAccessToken(oauthConfig, refreshToken);

    const uploadUrl = await initiateResumableUpload(accessToken, mediaAsset.fileSizeBytes, {
      title: captionPayload.title ?? mediaAsset.originalFilename,
      description: captionPayload.caption,
      // Native scheduling (TDD.md §1.3): upload happens now regardless of
      // how far out scheduledAt is — the file transfer and the "reveal" are
      // decoupled. A scheduled video uploads as `private`; YouTube itself
      // flips it to public at `publishAt`.
      privacyStatus: scheduledAt ? 'private' : 'public',
      publishAt: scheduledAt?.toISOString(),
    });

    const video = await uploadVideoChunks(
      uploadUrl,
      accessToken,
      media.buffer,
      mediaAsset.fileSizeBytes,
    );

    return {
      platformPostId: video.id,
      status: scheduledAt ? 'native_scheduled' : 'published',
    };
  },

  async checkStatus(): Promise<StatusResult> {
    // Real status polling (tracking a scheduled video's flip from private to
    // its target visibility) lands in its own milestone (#29) alongside the
    // rest of YouTube's native-scheduling wiring.
    return { status: 'pending' };
  },

  validateMediaConstraints(mediaAsset: MediaAssetRef): ValidationWarning[] {
    const warnings: ValidationWarning[] = [];

    // YouTube Shorts: up to 180 seconds (3 minutes) since YouTube's 2024
    // Shorts duration extension (previously 60s) — re-verify at real-adapter
    // implementation time. Exceeding this doesn't block the upload, it just
    // won't be classified/surfaced as a Short — a warning, not blocking.
    if (mediaAsset.durationSeconds !== undefined && mediaAsset.durationSeconds > 180) {
      warnings.push({
        code: 'exceeds_shorts_duration',
        severity: 'warning',
        affectedField: 'duration',
        message: `This video is ${mediaAsset.durationSeconds}s, over YouTube's 180s Shorts limit — it will upload as a regular video, not a Short.`,
      });
    }
    if (mediaAsset.width && mediaAsset.height && mediaAsset.width > mediaAsset.height) {
      warnings.push({
        code: 'non_vertical_aspect_ratio',
        severity: 'warning',
        affectedField: 'aspectRatio',
        message:
          'YouTube Shorts are recommended to be vertical (9:16) or square; this video is landscape.',
      });
    }
    return warnings;
  },
};

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
import { googleGet } from './googleClient.js';
import type { GoogleOAuthConfig } from './oauth.js';
import { refreshAccessToken } from './oauth.js';
import { initiateResumableUpload, uploadVideoChunks } from './upload.js';

/**
 * TargetDescriptor (packages/shared) has no token fields, so the caller (the
 * worker's publish/poll-status processors) is responsible for decrypting the
 * *connection's* refresh token (not a per-target one — publish_targets stays
 * tokenless for youtube_channel rows, see upsertGoogleConnection.ts) and
 * passing it through via `metadata`.
 */
export interface YouTubeAuthMetadata {
  refreshToken: string;
  oauthConfig: Pick<GoogleOAuthConfig, 'clientId' | 'clientSecret'>;
}

export interface YouTubePublishMetadata extends YouTubeAuthMetadata {
  media: { buffer: Buffer };
}

function requireYouTubeAuthMetadata(target: TargetDescriptor): YouTubeAuthMetadata {
  const metadata = target.metadata as Partial<YouTubeAuthMetadata> | undefined;
  if (
    !metadata ||
    typeof metadata.refreshToken !== 'string' ||
    !metadata.oauthConfig?.clientId ||
    !metadata.oauthConfig?.clientSecret
  ) {
    throw new Error(
      'target.metadata.{refreshToken, oauthConfig} are required to act on a YouTube channel',
    );
  }
  return { refreshToken: metadata.refreshToken, oauthConfig: metadata.oauthConfig };
}

function requireYouTubeMetadata(target: TargetDescriptor): YouTubePublishMetadata {
  const auth = requireYouTubeAuthMetadata(target);
  const media = (target.metadata as Partial<YouTubePublishMetadata> | undefined)?.media;
  if (!media?.buffer) {
    throw new Error(
      'target.metadata.{refreshToken, oauthConfig, media.buffer} are required to publish to a YouTube channel',
    );
  }
  return { ...auth, media };
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

  async checkStatus(target: TargetDescriptor, platformPostId: string): Promise<StatusResult> {
    const { refreshToken, oauthConfig } = requireYouTubeAuthMetadata(target);
    const { accessToken } = await refreshAccessToken(oauthConfig, refreshToken);

    const result = await googleGet<{
      items?: Array<{ status?: { privacyStatus?: string; publishAt?: string } }>;
    }>('/videos', { part: 'status', id: platformPostId }, accessToken);

    const video = result.items?.[0];
    if (!video) {
      return {
        status: 'failed',
        errorMessage: `YouTube reported no video found for id ${platformPostId}`,
      };
    }

    const privacyStatus = video.status?.privacyStatus;
    if (privacyStatus && privacyStatus !== 'private') {
      return {
        status: 'published',
        permalinkUrl: `https://www.youtube.com/watch?v=${platformPostId}`,
      };
    }

    // Still private. Expected while waiting for a scheduled publishAt that
    // hasn't arrived yet — only a real problem once that time has already
    // passed, per acceptance criteria: surface the requested/actual
    // visibility mismatch (most likely the compliance-audit restriction,
    // TDD.md §1.3, holding every upload to private pre-audit) as a distinct,
    // explained failure rather than staying silently "pending" forever.
    const publishAt = video.status?.publishAt;
    if (publishAt && new Date(publishAt).getTime() <= Date.now()) {
      return {
        status: 'failed',
        errorMessage: `YouTube kept this video private past its scheduled publish time (${publishAt}) — likely blocked by the pending YouTube API compliance audit; it was not actually published.`,
      };
    }
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

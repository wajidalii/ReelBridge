import { createMockAdapter } from '@reelbridge/shared';
import type { MediaAssetRef, PlatformAdapter, ValidationWarning } from '@reelbridge/shared';

/**
 * publish/checkStatus/discoverTargets are mock stand-ins until the real
 * YouTube adapter lands in its own milestone (YouTube Adapter, #27-31). Only
 * validateMediaConstraints is real here — needed now by the batch preview
 * endpoint (#20) to warn about YouTube Shorts constraints ahead of scheduling.
 */
export const youtubeChannelAdapter: PlatformAdapter = {
  ...createMockAdapter('youtube_channel'),

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

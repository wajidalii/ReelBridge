import { createMockAdapter } from '@reelbridge/shared';
import type { MediaAssetRef, PlatformAdapter, ValidationWarning } from '@reelbridge/shared';

/**
 * publish/checkStatus/discoverTargets are mock stand-ins until the real
 * Instagram adapter lands in its own milestone (Instagram Adapter, #32-35).
 * Only validateMediaConstraints is real here — needed now by the batch
 * preview endpoint (#20) to warn about Instagram Reels constraints ahead of
 * scheduling, well before the actual publish path exists.
 */
export const instagramBusinessAdapter: PlatformAdapter = {
  ...createMockAdapter('instagram_business'),

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

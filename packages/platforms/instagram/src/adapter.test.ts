import type { MediaAssetRef } from '@reelbridge/shared';
import { describe, expect, it } from 'vitest';
import { instagramBusinessAdapter } from './adapter.js';

const mediaAsset: MediaAssetRef = {
  mediaAssetId: 'media-1',
  storageKey: 'user-1/media-1.mp4',
  originalFilename: 'clip.mp4',
  fileSizeBytes: 1000,
};

describe('instagramBusinessAdapter.validateMediaConstraints', () => {
  it('blocks when duration is outside the 3-90 second Reels range', () => {
    const warnings = instagramBusinessAdapter.validateMediaConstraints({
      ...mediaAsset,
      durationSeconds: 120,
    });
    const warning = warnings.find((w) => w.code === 'duration_out_of_range');
    expect(warning).toMatchObject({ severity: 'blocking', affectedField: 'duration' });
  });

  it('blocks when duration is below the 3 second minimum', () => {
    const warnings = instagramBusinessAdapter.validateMediaConstraints({
      ...mediaAsset,
      durationSeconds: 1,
    });
    expect(warnings.some((w) => w.code === 'duration_out_of_range')).toBe(true);
  });

  it('warns (non-blocking) when aspect ratio is landscape rather than vertical', () => {
    const warnings = instagramBusinessAdapter.validateMediaConstraints({
      ...mediaAsset,
      width: 1920,
      height: 1080,
    });
    const warning = warnings.find((w) => w.code === 'non_vertical_aspect_ratio');
    expect(warning).toMatchObject({ severity: 'warning', affectedField: 'aspectRatio' });
  });

  it('returns no warnings for a conforming video', () => {
    const warnings = instagramBusinessAdapter.validateMediaConstraints({
      ...mediaAsset,
      durationSeconds: 30,
      width: 1080,
      height: 1920,
    });
    expect(warnings).toHaveLength(0);
  });
});

import type { MediaAssetRef } from '@reelbridge/shared';
import { describe, expect, it } from 'vitest';
import { youtubeChannelAdapter } from './adapter.js';

const mediaAsset: MediaAssetRef = {
  mediaAssetId: 'media-1',
  storageKey: 'user-1/media-1.mp4',
  originalFilename: 'clip.mp4',
  fileSizeBytes: 1000,
};

describe('youtubeChannelAdapter.validateMediaConstraints', () => {
  it('warns (non-blocking) when duration exceeds the 180 second Shorts limit', () => {
    const warnings = youtubeChannelAdapter.validateMediaConstraints({
      ...mediaAsset,
      durationSeconds: 200,
    });
    const warning = warnings.find((w) => w.code === 'exceeds_shorts_duration');
    expect(warning).toMatchObject({ severity: 'warning', affectedField: 'duration' });
  });

  it('warns (non-blocking) when aspect ratio is landscape rather than vertical', () => {
    const warnings = youtubeChannelAdapter.validateMediaConstraints({
      ...mediaAsset,
      width: 1920,
      height: 1080,
    });
    const warning = warnings.find((w) => w.code === 'non_vertical_aspect_ratio');
    expect(warning).toMatchObject({ severity: 'warning', affectedField: 'aspectRatio' });
  });

  it('returns no warnings for a conforming video', () => {
    const warnings = youtubeChannelAdapter.validateMediaConstraints({
      ...mediaAsset,
      durationSeconds: 45,
      width: 1080,
      height: 1920,
    });
    expect(warnings).toHaveLength(0);
  });
});

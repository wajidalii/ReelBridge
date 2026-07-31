import { facebookPageAdapter } from '@reelbridge/platform-facebook';
import { instagramBusinessAdapter } from '@reelbridge/platform-instagram';
import { youtubeChannelAdapter } from '@reelbridge/platform-youtube';
import type { PlatformAdapter, PlatformType } from '@reelbridge/shared';

/**
 * Used by the preview endpoint's validateMediaConstraints/capabilities checks
 * across all three platforms. Distinct from the worker's publish-dispatch
 * table (packages/worker/src/processors/publishToTarget.ts), which stays
 * Facebook-only until the real Instagram/YouTube adapters land — this one is
 * safe to include all three since validation never actually publishes anything.
 */
export const PREVIEW_ADAPTERS_BY_PLATFORM: Partial<Record<PlatformType, PlatformAdapter>> = {
  facebook_page: facebookPageAdapter,
  instagram_business: instagramBusinessAdapter,
  youtube_channel: youtubeChannelAdapter,
};

import type { PlatformType } from '../platform-adapter.js';

export interface RateLimiterConfig {
  max: number;
  duration: number; // ms
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Worker-level limiter per (platform, external account) queue — TDD.md §5
 * risk 6. These are deliberately *under* each platform's published ceiling
 * so ReelBridge never has to be the thing that trips the platform's own
 * limiter:
 *
 * - Instagram: 100 API-published posts per rolling 24h per professional
 *   account (issue #35). The worker additionally checks
 *   `content_publishing_limit` before each publish and defers when Meta
 *   says the quota is used up, since posts made outside ReelBridge count too.
 * - YouTube: `videos.insert` has a 100/day per-project bucket (TDD.md §1.3)
 *   — that's per *project*, shared across every connected channel, so the
 *   per-channel limiter here is only a smoothing cap; the real guard is the
 *   quota-exceeded deferral in the publish processor.
 * - Facebook: Graph API rate limits are per app/Page and generous for this
 *   volume; the cap just prevents a single Page's batch from being uploaded
 *   as one burst.
 */
export const PLATFORM_RATE_LIMITS: Record<PlatformType, RateLimiterConfig> = {
  facebook_page: { max: 30, duration: HOUR_MS },
  instagram_business: { max: 90, duration: DAY_MS },
  youtube_channel: { max: 20, duration: HOUR_MS },
};

import type { PlatformType } from '../platform-adapter.js';

/**
 * Rate limits are per (platform, external account/project), not global or
 * per-platform-type: Instagram's 100-posts/24h and YouTube's upload-bucket cap
 * are both per-account/per-project constraints distinct from Facebook's Graph
 * API throttling (TDD.md §5 risk 6). Open-source BullMQ's rate limiter lives
 * on the Worker, not the Queue, so the concrete mechanism here is one
 * queue+worker pair per key, not a single global queue with an internal limiter.
 */
// `|`-delimited, not `:` — BullMQ's QueueBase rejects any queue name containing
// a colon, and this key doubles as the queue name suffix in
// publishToTargetQueueName below.
export function rateLimiterKey(platform: PlatformType, externalAccountOrProjectId: string): string {
  return `${platform}|${externalAccountOrProjectId}`;
}

export function publishToTargetQueueName(
  platform: PlatformType,
  externalAccountOrProjectId: string,
): string {
  return `publish-to-target|${rateLimiterKey(platform, externalAccountOrProjectId)}`;
}

/**
 * Poll-status checks are read-only status lookups, not write actions subject to
 * the same per-account publish-rate constraints, so a single shared queue is
 * used rather than one per target.
 */
export const POLL_STATUS_QUEUE_NAME = 'poll-status';

import { describe, expect, it } from 'vitest';
import { publishToTargetQueueName, rateLimiterKey } from './keys.js';

// BullMQ's QueueBase throws "Queue name cannot contain :" unconditionally, so
// any regression back to a colon delimiter here breaks enqueuePublishToTarget
// for every call, not just some inputs — regression-tested directly rather
// than relying only on the DB+Redis-gated integration tests, which can skip
// silently in an environment without those services.
describe('queue key builders', () => {
  it('rateLimiterKey never contains a colon', () => {
    const key = rateLimiterKey('facebook_page', 'external-account-id');
    expect(key).not.toContain(':');
  });

  it('publishToTargetQueueName never contains a colon', () => {
    const name = publishToTargetQueueName('instagram_business', 'external-account-id');
    expect(name).not.toContain(':');
  });
});

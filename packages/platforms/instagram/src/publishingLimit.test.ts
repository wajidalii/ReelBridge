import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertPublishingHeadroom,
  fetchContentPublishingLimit,
  InstagramPublishingLimitExceededError,
} from './publishingLimit.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Instagram content_publishing_limit (issue #35)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads quota_usage and quota_total from the Graph API shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        expect(input.toString()).toContain(
          '/ig-1/content_publishing_limit?fields=quota_usage%2Cconfig',
        );
        return jsonResponse({ data: [{ quota_usage: 42, config: { quota_total: 100 } }] });
      }),
    );
    expect(await fetchContentPublishingLimit('ig-1', 'tok')).toEqual({
      quotaUsage: 42,
      quotaTotal: 100,
    });
  });

  it('defaults to the documented 100/24h when config is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [{ quota_usage: 1 }] })),
    );
    expect(await fetchContentPublishingLimit('ig-1', 'tok')).toEqual({
      quotaUsage: 1,
      quotaTotal: 100,
    });
  });

  it('assertPublishingHeadroom throws a typed error at the ceiling and passes below it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ data: [{ quota_usage: 100, config: { quota_total: 100 } }] }),
      ),
    );
    await expect(assertPublishingHeadroom('ig-1', 'tok')).rejects.toBeInstanceOf(
      InstagramPublishingLimitExceededError,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ data: [{ quota_usage: 99, config: { quota_total: 100 } }] }),
      ),
    );
    await expect(assertPublishingHeadroom('ig-1', 'tok')).resolves.toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchUserChannels } from './discovery.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchUserChannels', () => {
  it('maps channel items and sends the access token as a bearer header', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      expect(url.pathname).toBe('/youtube/v3/channels');
      expect(url.searchParams.get('mine')).toBe('true');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
      return jsonResponse({
        items: [
          { id: 'chan-1', snippet: { title: 'Chan One', thumbnails: { default: { url: 'https://x/1.jpg' } } } },
          { id: 'chan-2', snippet: {} },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const channels = await fetchUserChannels('token-123');
    expect(channels).toEqual([
      { id: 'chan-1', title: 'Chan One', thumbnailUrl: 'https://x/1.jpg' },
      { id: 'chan-2', title: 'chan-2', thumbnailUrl: undefined },
    ]);
  });

  it('returns an empty array when the account has no channels', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );
    const channels = await fetchUserChannels('token-123');
    expect(channels).toEqual([]);
  });
});

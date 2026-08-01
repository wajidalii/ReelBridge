import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContainerPollingTimeoutError,
  ContainerProcessingError,
  createMediaContainer,
  fetchPermalink,
  getContainerStatus,
  publishContainer,
  waitForContainerFinished,
} from './container.js';

const IG_USER_ID = 'ig-user-1';
const ACCESS_TOKEN = 'page-access-token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createMediaContainer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs media_type=REELS with the signed video_url and caption', async () => {
    let capturedParams: URLSearchParams | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(input.toString()).toContain(`/${IG_USER_ID}/media`);
        capturedParams = init?.body as URLSearchParams;
        return jsonResponse({ id: 'container-1' });
      }),
    );

    const result = await createMediaContainer(
      IG_USER_ID,
      ACCESS_TOKEN,
      'https://storage.example/signed/video.mp4',
      'Check this out',
    );

    expect(result).toEqual({ creationId: 'container-1' });
    expect(capturedParams?.get('media_type')).toBe('REELS');
    expect(capturedParams?.get('video_url')).toBe('https://storage.example/signed/video.mp4');
    expect(capturedParams?.get('caption')).toBe('Check this out');
    expect(capturedParams?.get('access_token')).toBe(ACCESS_TOKEN);
  });
});

describe('getContainerStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs status_code and status for the container', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input.toString());
        expect(url.pathname).toContain('/container-1');
        expect(url.searchParams.get('fields')).toBe('status_code,status');
        return jsonResponse({ status_code: 'IN_PROGRESS', status: 'Processing' });
      }),
    );

    const result = await getContainerStatus('container-1', ACCESS_TOKEN);
    expect(result).toEqual({ statusCode: 'IN_PROGRESS', statusText: 'Processing' });
  });
});

describe('waitForContainerFinished', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves once status flips to FINISHED, polling in between', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount += 1;
        if (callCount < 3) {
          return jsonResponse({ status_code: 'IN_PROGRESS' });
        }
        return jsonResponse({ status_code: 'FINISHED' });
      }),
    );

    await waitForContainerFinished('container-1', ACCESS_TOKEN, { intervalMs: 1 });
    expect(callCount).toBe(3);
  });

  it('throws ContainerProcessingError immediately on ERROR without further polling', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status_code: 'ERROR', status: 'Video format not supported' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      waitForContainerFinished('container-1', ACCESS_TOKEN, { intervalMs: 1 }),
    ).rejects.toThrow(ContainerProcessingError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ContainerProcessingError on EXPIRED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status_code: 'EXPIRED' })),
    );

    await expect(
      waitForContainerFinished('container-1', ACCESS_TOKEN, { intervalMs: 1 }),
    ).rejects.toThrow(ContainerProcessingError);
  });

  it('gives up with ContainerPollingTimeoutError rather than polling forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status_code: 'IN_PROGRESS' })),
    );

    await expect(
      waitForContainerFinished('container-1', ACCESS_TOKEN, { intervalMs: 1, timeoutMs: 5 }),
    ).rejects.toThrow(ContainerPollingTimeoutError);
  });
});

describe('publishContainer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the creation_id to media_publish and returns the resulting media id', async () => {
    let capturedParams: URLSearchParams | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(input.toString()).toContain(`/${IG_USER_ID}/media_publish`);
        capturedParams = init?.body as URLSearchParams;
        return jsonResponse({ id: 'media-1' });
      }),
    );

    const result = await publishContainer(IG_USER_ID, ACCESS_TOKEN, 'container-1');
    expect(result).toEqual({ mediaId: 'media-1' });
    expect(capturedParams?.get('creation_id')).toBe('container-1');
  });
});

describe('fetchPermalink', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the permalink when available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ permalink: 'https://instagram.com/p/abc123' })),
    );

    const permalink = await fetchPermalink('media-1', ACCESS_TOKEN);
    expect(permalink).toBe('https://instagram.com/p/abc123');
  });

  it('is best-effort — swallows a Graph API error rather than failing the publish', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'nope' }, 500)),
    );

    const permalink = await fetchPermalink('media-1', ACCESS_TOKEN);
    expect(permalink).toBeUndefined();
  });
});

import type { CaptionPayload, MediaAssetRef, TargetDescriptor } from '@reelbridge/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instagramBusinessAdapter } from './adapter.js';

const mediaAsset: MediaAssetRef = {
  mediaAssetId: 'media-1',
  storageKey: 'user-1/media-1.mp4',
  originalFilename: 'clip.mp4',
  fileSizeBytes: 1000,
};

const IG_USER_ID = 'ig-user-1';
const caption: CaptionPayload = { caption: 'Check this out' };

function buildTarget(overrides?: Partial<TargetDescriptor>): TargetDescriptor {
  return {
    externalId: IG_USER_ID,
    displayName: 'Test IG Account',
    metadata: {
      accessToken: 'page-access-token',
      videoUrl: 'https://storage.example/signed/video.mp4',
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('instagramBusinessAdapter.publish', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a container, polls until finished, publishes, and backfills the permalink', async () => {
    let containerCreateParams: URLSearchParams | undefined;
    let publishParams: URLSearchParams | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const urlStr = input.toString();
        if (urlStr.includes(`/${IG_USER_ID}/media`) && !urlStr.includes('media_publish')) {
          containerCreateParams = init?.body as URLSearchParams;
          return jsonResponse({ id: 'container-1' });
        }
        if (urlStr.includes('/container-1') && !init) {
          return jsonResponse({ status_code: 'FINISHED' });
        }
        if (urlStr.includes(`/${IG_USER_ID}/media_publish`)) {
          publishParams = init?.body as URLSearchParams;
          return jsonResponse({ id: 'media-1' });
        }
        if (urlStr.includes('/media-1')) {
          return jsonResponse({ permalink: 'https://instagram.com/p/abc123' });
        }
        throw new Error(`Unexpected fetch call: ${urlStr}`);
      }),
    );

    const result = await instagramBusinessAdapter.publish(buildTarget(), mediaAsset, caption);

    expect(result).toEqual({
      platformPostId: 'media-1',
      status: 'published',
      permalinkUrl: 'https://instagram.com/p/abc123',
    });
    expect(containerCreateParams?.get('media_type')).toBe('REELS');
    expect(containerCreateParams?.get('video_url')).toBe(
      'https://storage.example/signed/video.mp4',
    );
    expect(publishParams?.get('creation_id')).toBe('container-1');
  });

  it('always publishes immediately regardless of scheduledAt — Instagram has no native scheduling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const urlStr = input.toString();
        if (urlStr.includes('media_publish')) return jsonResponse({ id: 'media-2' });
        if (urlStr.includes(`/${IG_USER_ID}/media`)) return jsonResponse({ id: 'container-2' });
        if (urlStr.includes('/container-2')) return jsonResponse({ status_code: 'FINISHED' });
        if (urlStr.includes('/media-2')) return jsonResponse({});
        throw new Error(`Unexpected fetch call: ${urlStr}`);
      }),
    );

    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const result = await instagramBusinessAdapter.publish(
      buildTarget(),
      mediaAsset,
      caption,
      farFuture,
    );
    expect(result.status).toBe('published');
  });

  it('propagates a container ERROR status as a rejected publish', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const urlStr = input.toString();
        if (urlStr.includes(`/${IG_USER_ID}/media`)) return jsonResponse({ id: 'container-3' });
        return jsonResponse({ status_code: 'ERROR', status: 'Video too short' });
      }),
    );

    await expect(
      instagramBusinessAdapter.publish(buildTarget(), mediaAsset, caption),
    ).rejects.toThrow(/ERROR/);
  });

  it('throws a clear error when target.metadata is missing the access token or video URL', async () => {
    await expect(
      instagramBusinessAdapter.publish(buildTarget({ metadata: {} }), mediaAsset, caption),
    ).rejects.toThrow(/accessToken.*videoUrl/);
  });
});

describe('instagramBusinessAdapter.checkStatus', () => {
  it('returns published — publish() is synchronous, so this is never reached for a real row', async () => {
    const result = await instagramBusinessAdapter.checkStatus(buildTarget(), 'media-1');
    expect(result).toEqual({ status: 'published' });
  });
});

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

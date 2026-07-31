import type { CaptionPayload, MediaAssetRef, TargetDescriptor } from '@reelbridge/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { facebookPageAdapter, FacebookScheduleWindowError } from './adapter.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PAGE_ID = 'page-1';
const PAGE_TOKEN = 'page-token';
const UPLOAD_URL = 'https://upload.example/vid-1';

function buildTarget(overrides?: Partial<TargetDescriptor>): TargetDescriptor {
  return {
    externalId: PAGE_ID,
    displayName: 'Test Page',
    metadata: { accessToken: PAGE_TOKEN, media: { buffer: Buffer.from('fake-video-bytes') } },
    ...overrides,
  };
}

const mediaAsset: MediaAssetRef = {
  mediaAssetId: 'media-1',
  storageKey: 'user-1/media-1.mp4',
  originalFilename: 'clip.mp4',
  fileSizeBytes: Buffer.from('fake-video-bytes').length,
};

const caption: CaptionPayload = { caption: 'Hello from ReelBridge' };

describe('facebookPageAdapter.publish', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('performs the 3-phase upload and publishes immediately when no scheduledAt is given', async () => {
    let finishParams: URLSearchParams | undefined;

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = input.toString();

      if (urlStr === UPLOAD_URL) {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe(`OAuth ${PAGE_TOKEN}`);
        expect(headers.offset).toBe('0');
        expect(headers.file_size).toBe(String(mediaAsset.fileSizeBytes));
        expect(init?.body).toBeInstanceOf(Buffer);
        return jsonResponse({ success: true });
      }

      if (urlStr.includes(`/${PAGE_ID}/video_reels`) && init?.body instanceof URLSearchParams) {
        const params = init.body;
        if (params.get('upload_phase') === 'start') {
          expect(params.get('access_token')).toBe(PAGE_TOKEN);
          return jsonResponse({ video_id: 'vid-1', upload_url: UPLOAD_URL });
        }
        if (params.get('upload_phase') === 'finish') {
          finishParams = params;
          return jsonResponse({ success: true });
        }
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await facebookPageAdapter.publish(buildTarget(), mediaAsset, caption);

    expect(result).toEqual({ platformPostId: 'vid-1', status: 'published' });
    expect(finishParams?.get('video_id')).toBe('vid-1');
    expect(finishParams?.get('video_state')).toBe('PUBLISHED');
    expect(finishParams?.get('description')).toBe('Hello from ReelBridge');
    expect(finishParams?.has('scheduled_publish_time')).toBe(false);
  });

  it('sets video_state=SCHEDULED + scheduled_publish_time for a scheduled publish, within the valid window', async () => {
    let finishParams: URLSearchParams | undefined;
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour out

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = input.toString();
      if (urlStr === UPLOAD_URL) {
        return jsonResponse({ success: true });
      }
      if (urlStr.includes(`/${PAGE_ID}/video_reels`) && init?.body instanceof URLSearchParams) {
        const params = init.body;
        if (params.get('upload_phase') === 'start') {
          return jsonResponse({ video_id: 'vid-2', upload_url: UPLOAD_URL });
        }
        if (params.get('upload_phase') === 'finish') {
          finishParams = params;
          return jsonResponse({ success: true });
        }
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await facebookPageAdapter.publish(
      buildTarget(),
      mediaAsset,
      caption,
      scheduledAt,
    );

    expect(result).toEqual({ platformPostId: 'vid-2', status: 'native_scheduled' });
    expect(finishParams?.get('video_state')).toBe('SCHEDULED');
    expect(finishParams?.get('scheduled_publish_time')).toBe(
      String(Math.floor(scheduledAt.getTime() / 1000)),
    );
  });

  it('rejects a scheduledAt less than 10 minutes out, without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const tooSoon = new Date(Date.now() + 5 * 60 * 1000);
    await expect(
      facebookPageAdapter.publish(buildTarget(), mediaAsset, caption, tooSoon),
    ).rejects.toThrow(FacebookScheduleWindowError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a scheduledAt more than 29 days out, without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const tooFar = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    await expect(
      facebookPageAdapter.publish(buildTarget(), mediaAsset, caption, tooFar),
    ).rejects.toThrow(FacebookScheduleWindowError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a clear error when target.metadata is missing the access token or media buffer', async () => {
    await expect(
      facebookPageAdapter.publish(buildTarget({ metadata: {} }), mediaAsset, caption),
    ).rejects.toThrow(/accessToken.*media\.buffer/);
  });
});

describe('facebookPageAdapter.checkStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a published video to status=published with its permalink', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: { video_status: 'published' },
          permalink_url: 'https://facebook.com/watch/?v=vid-1',
        }),
      ),
    );

    const result = await facebookPageAdapter.checkStatus(buildTarget(), 'vid-1');
    expect(result).toEqual({
      status: 'published',
      permalinkUrl: 'https://facebook.com/watch/?v=vid-1',
    });
  });

  it('maps an error video_status to status=failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: { video_status: 'error' } })),
    );

    const result = await facebookPageAdapter.checkStatus(buildTarget(), 'vid-1');
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBeDefined();
  });

  it('maps any other video_status to status=pending', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: { video_status: 'processing' } })),
    );

    const result = await facebookPageAdapter.checkStatus(buildTarget(), 'vid-1');
    expect(result.status).toBe('pending');
  });
});

describe('facebookPageAdapter.validateMediaConstraints', () => {
  it('blocks when duration is outside the 4-90 second Reels range', () => {
    const warnings = facebookPageAdapter.validateMediaConstraints({
      ...mediaAsset,
      durationSeconds: 120,
    });
    const warning = warnings.find((w) => w.code === 'duration_out_of_range');
    expect(warning).toMatchObject({ severity: 'blocking', affectedField: 'duration' });
  });

  it('warns (non-blocking) when aspect ratio is landscape rather than vertical', () => {
    const warnings = facebookPageAdapter.validateMediaConstraints({
      ...mediaAsset,
      width: 1920,
      height: 1080,
    });
    const warning = warnings.find((w) => w.code === 'non_vertical_aspect_ratio');
    expect(warning).toMatchObject({ severity: 'warning', affectedField: 'aspectRatio' });
  });

  it('returns no warnings for a conforming video', () => {
    const warnings = facebookPageAdapter.validateMediaConstraints({
      ...mediaAsset,
      durationSeconds: 30,
      width: 1080,
      height: 1920,
    });
    expect(warnings).toHaveLength(0);
  });
});

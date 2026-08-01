import type { CaptionPayload, MediaAssetRef, TargetDescriptor } from '@reelbridge/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { youtubeChannelAdapter } from './adapter.js';

const VIDEO_BYTES = Buffer.from('fake-video-bytes');

const mediaAsset: MediaAssetRef = {
  mediaAssetId: 'media-1',
  storageKey: 'user-1/media-1.mp4',
  originalFilename: 'clip.mp4',
  fileSizeBytes: VIDEO_BYTES.length,
};

const caption: CaptionPayload = { caption: 'A description', title: 'My Reel' };
const UPLOAD_SESSION_URL = 'https://upload.example/session/abc';

function buildTarget(overrides?: Partial<TargetDescriptor>): TargetDescriptor {
  return {
    externalId: 'channel-1',
    displayName: 'Test Channel',
    metadata: {
      refreshToken: 'stored-refresh-token',
      oauthConfig: { clientId: 'client-id', clientSecret: 'client-secret' },
      media: { buffer: VIDEO_BYTES },
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

describe('youtubeChannelAdapter.publish', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refreshes the access token, uploads resumably, and publishes immediately when no scheduledAt is given', async () => {
    let sawRefreshCall = false;
    let sawInitiateCall = false;

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = input.toString();

      if (urlStr === 'https://oauth2.googleapis.com/token') {
        sawRefreshCall = true;
        const params = init?.body as URLSearchParams;
        expect(params.get('grant_type')).toBe('refresh_token');
        expect(params.get('refresh_token')).toBe('stored-refresh-token');
        return jsonResponse({ access_token: 'fresh-access-token', expires_in: 3600 });
      }

      if (urlStr.includes('uploadType=resumable')) {
        sawInitiateCall = true;
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer fresh-access-token');
        const body = JSON.parse(init?.body as string);
        expect(body.snippet.title).toBe('My Reel');
        expect(body.status.privacyStatus).toBe('public');
        expect(body.status).not.toHaveProperty('publishAt');
        return new Response(null, { status: 200, headers: { Location: UPLOAD_SESSION_URL } });
      }

      if (urlStr === UPLOAD_SESSION_URL) {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer fresh-access-token');
        return jsonResponse({ id: 'yt-video-1' });
      }

      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await youtubeChannelAdapter.publish(buildTarget(), mediaAsset, caption);

    expect(sawRefreshCall).toBe(true);
    expect(sawInitiateCall).toBe(true);
    expect(result).toEqual({ platformPostId: 'yt-video-1', status: 'published' });
  });

  it('uploads as private with publishAt for a scheduled publish, native scheduling', async () => {
    const scheduledAt = new Date('2026-06-01T12:00:00.000Z');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const urlStr = input.toString();
        if (urlStr === 'https://oauth2.googleapis.com/token') {
          return jsonResponse({ access_token: 'fresh-access-token', expires_in: 3600 });
        }
        if (urlStr.includes('uploadType=resumable')) {
          const body = JSON.parse(init?.body as string);
          expect(body.status.privacyStatus).toBe('private');
          expect(body.status.publishAt).toBe(scheduledAt.toISOString());
          return new Response(null, { status: 200, headers: { Location: UPLOAD_SESSION_URL } });
        }
        if (urlStr === UPLOAD_SESSION_URL) {
          return jsonResponse({ id: 'yt-video-2' });
        }
        throw new Error(`Unexpected fetch call: ${urlStr}`);
      }),
    );

    const result = await youtubeChannelAdapter.publish(
      buildTarget(),
      mediaAsset,
      caption,
      scheduledAt,
    );

    expect(result).toEqual({ platformPostId: 'yt-video-2', status: 'native_scheduled' });
  });

  it('throws a clear error when target.metadata is missing the refresh token, oauth config, or media buffer', async () => {
    await expect(
      youtubeChannelAdapter.publish(buildTarget({ metadata: {} }), mediaAsset, caption),
    ).rejects.toThrow(/refreshToken.*oauthConfig.*media\.buffer/);
  });
});

describe('youtubeChannelAdapter.checkStatus', () => {
  it('returns pending — real status polling lands in its own milestone', async () => {
    const result = await youtubeChannelAdapter.checkStatus(buildTarget(), 'yt-video-1');
    expect(result).toEqual({ status: 'pending' });
  });
});

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

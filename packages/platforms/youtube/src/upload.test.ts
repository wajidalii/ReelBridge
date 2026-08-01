import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleApiError } from './googleClient.js';
import { initiateResumableUpload, uploadVideoChunks } from './upload.js';

const ACCESS_TOKEN = 'access-token';
const UPLOAD_SESSION_URL = 'https://upload.example/session/abc';

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('initiateResumableUpload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs metadata and returns the session URI from the Location header', async () => {
    let capturedBody: unknown;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toContain('uploadType=resumable');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(headers['X-Upload-Content-Length']).toBe('1000');
      capturedBody = JSON.parse(init?.body as string);
      return new Response(null, { status: 200, headers: { Location: UPLOAD_SESSION_URL } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const uploadUrl = await initiateResumableUpload(ACCESS_TOKEN, 1000, {
      title: 'My Reel',
      description: 'A description',
      privacyStatus: 'private',
      publishAt: '2026-01-01T00:00:00.000Z',
    });

    expect(uploadUrl).toBe(UPLOAD_SESSION_URL);
    expect(capturedBody).toMatchObject({
      snippet: { title: 'My Reel', description: 'A description', categoryId: '22' },
      status: { privacyStatus: 'private', publishAt: '2026-01-01T00:00:00.000Z' },
    });
  });

  it('omits publishAt when not scheduling', async () => {
    let capturedBody: { status: Record<string, unknown> } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(null, { status: 200, headers: { Location: UPLOAD_SESSION_URL } });
      }),
    );

    await initiateResumableUpload(ACCESS_TOKEN, 1000, {
      title: 'My Reel',
      description: 'desc',
      privacyStatus: 'public',
    });

    expect(capturedBody?.status).not.toHaveProperty('publishAt');
  });

  it('throws when YouTube returns no Location header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    await expect(
      initiateResumableUpload(ACCESS_TOKEN, 1000, {
        title: 't',
        description: 'd',
        privacyStatus: 'public',
      }),
    ).rejects.toThrow(GoogleApiError);
  });

  it('throws when the session-creation request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'nope' }, 401)),
    );

    await expect(
      initiateResumableUpload(ACCESS_TOKEN, 1000, {
        title: 't',
        description: 'd',
        privacyStatus: 'public',
      }),
    ).rejects.toThrow(/status 401/);
  });
});

describe('uploadVideoChunks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads a single chunk that fits under the chunk size limit', async () => {
    const buffer = Buffer.from('a'.repeat(1000));
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe(UPLOAD_SESSION_URL);
      const headers = init?.headers as Record<string, string>;
      expect(headers['Content-Range']).toBe(`bytes 0-999/1000`);
      return jsonResponse({ id: 'yt-video-1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await uploadVideoChunks(UPLOAD_SESSION_URL, ACCESS_TOKEN, buffer, buffer.length);
    expect(result).toEqual({ id: 'yt-video-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resumes after a transient failure by querying YouTube for the actual received offset', async () => {
    const buffer = Buffer.from('a'.repeat(1000));
    let callCount = 0;

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      const headers = init?.headers as Record<string, string>;

      if (callCount === 1) {
        // First chunk attempt: network failure mid-flight.
        expect(headers['Content-Range']).toBe('bytes 0-999/1000');
        throw new Error('network error');
      }
      if (callCount === 2) {
        // Retry queries progress — YouTube says it actually received the
        // first 500 bytes durably before the connection dropped.
        expect(headers['Content-Range']).toBe('bytes */1000');
        return new Response(null, { status: 308, headers: { Range: 'bytes=0-499' } });
      }
      // Third call resumes from byte 500, not from 0.
      expect(headers['Content-Range']).toBe('bytes 500-999/1000');
      return jsonResponse({ id: 'yt-video-2' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await uploadVideoChunks(UPLOAD_SESSION_URL, ACCESS_TOKEN, buffer, buffer.length);
    expect(result).toEqual({ id: 'yt-video-2' });
    expect(callCount).toBe(3);
  });

  it('treats a progress query reporting completion as success, even without a fresh chunk response', async () => {
    const buffer = Buffer.from('a'.repeat(1000));
    let callCount = 0;

    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('network error');
      }
      // The chunk actually landed on Google's side before the client saw the
      // failure — the progress query itself returns the finished video.
      return jsonResponse({ id: 'yt-video-3' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await uploadVideoChunks(UPLOAD_SESSION_URL, ACCESS_TOKEN, buffer, buffer.length);
    expect(result).toEqual({ id: 'yt-video-3' });
  });

  it('gives up after exhausting retries for a single chunk', async () => {
    const buffer = Buffer.from('a'.repeat(1000));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('persistent network error');
      }),
    );

    await expect(
      uploadVideoChunks(UPLOAD_SESSION_URL, ACCESS_TOKEN, buffer, buffer.length),
    ).rejects.toThrow('persistent network error');
  });

  it('uploads multiple chunks in sequence for a file larger than the chunk size', async () => {
    const chunkSize = 8 * 1024 * 1024;
    const buffer = Buffer.alloc(chunkSize + 100, 'a');
    const ranges: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        ranges.push(headers['Content-Range'] ?? '');
        if (ranges.length === 1) {
          return new Response(null, {
            status: 308,
            headers: { Range: `bytes=0-${chunkSize - 1}` },
          });
        }
        return jsonResponse({ id: 'yt-video-multi' });
      }),
    );

    const result = await uploadVideoChunks(UPLOAD_SESSION_URL, ACCESS_TOKEN, buffer, buffer.length);
    expect(result).toEqual({ id: 'yt-video-multi' });
    expect(ranges).toEqual([
      `bytes 0-${chunkSize - 1}/${buffer.length}`,
      `bytes ${chunkSize}-${buffer.length - 1}/${buffer.length}`,
    ]);
  });
});

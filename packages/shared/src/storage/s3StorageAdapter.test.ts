import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const presignMock = vi.fn();

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => presignMock(...args),
}));

const { S3StorageAdapter } = await import('./s3StorageAdapter.js');

describe('S3StorageAdapter.getSignedUrl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    presignMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards the requested TTL to the presigner and returns its URL', async () => {
    presignMock.mockResolvedValue('https://signed.example/mock-url');
    const adapter = new S3StorageAdapter({ bucket: 'test-bucket' });

    const url = await adapter.getSignedUrl('user-1/media-1.mp4', 300);

    expect(url).toBe('https://signed.example/mock-url');
    expect(presignMock).toHaveBeenCalledTimes(1);

    const [, command, options] = presignMock.mock.calls[0] as [
      unknown,
      { input: unknown },
      unknown,
    ];
    expect(options).toEqual({ expiresIn: 300 });
    expect(command.input).toMatchObject({ Bucket: 'test-bucket', Key: 'user-1/media-1.mp4' });
  });

  it('passes distinct TTLs through for short- vs long-lived URLs', async () => {
    presignMock
      .mockResolvedValueOnce('https://signed.example/short')
      .mockResolvedValueOnce('https://signed.example/long');
    const adapter = new S3StorageAdapter({ bucket: 'test-bucket' });

    const shortUrl = await adapter.getSignedUrl('key.mp4', 60);
    const longUrl = await adapter.getSignedUrl('key.mp4', 3600);

    expect(shortUrl).not.toBe(longUrl);
    expect(presignMock.mock.calls[0]?.[2]).toEqual({ expiresIn: 60 });
    expect(presignMock.mock.calls[1]?.[2]).toEqual({ expiresIn: 3600 });
  });

  it('does not advance the clock between calls on its own (sanity check on the fake timer setup)', async () => {
    const before = Date.now();
    presignMock.mockResolvedValue('https://signed.example/mock-url');
    const adapter = new S3StorageAdapter({ bucket: 'test-bucket' });

    await adapter.getSignedUrl('key.mp4', 300);

    expect(Date.now()).toBe(before);
  });
});

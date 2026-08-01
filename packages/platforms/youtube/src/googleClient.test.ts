import { describe, expect, it } from 'vitest';
import { GoogleApiError, isQuotaExceededError } from './googleClient.js';

function quotaError(reason: string): GoogleApiError {
  return new GoogleApiError('quota exceeded', 403, { error: { errors: [{ reason }] } });
}

describe('isQuotaExceededError', () => {
  it('recognizes quotaExceeded', () => {
    expect(isQuotaExceededError(quotaError('quotaExceeded'))).toBe(true);
  });

  it('recognizes dailyLimitExceeded', () => {
    expect(isQuotaExceededError(quotaError('dailyLimitExceeded'))).toBe(true);
  });

  it('recognizes rateLimitExceeded', () => {
    expect(isQuotaExceededError(quotaError('rateLimitExceeded'))).toBe(true);
  });

  it('is false for a 403 with an unrelated reason (e.g. permission denied)', () => {
    expect(isQuotaExceededError(quotaError('forbidden'))).toBe(false);
  });

  it('is false for a non-403 GoogleApiError', () => {
    expect(isQuotaExceededError(new GoogleApiError('bad request', 400, {}))).toBe(false);
  });

  it('is false for a malformed error body', () => {
    expect(isQuotaExceededError(new GoogleApiError('oops', 403, undefined))).toBe(false);
  });

  it('is false for a non-GoogleApiError', () => {
    expect(isQuotaExceededError(new Error('network error'))).toBe(false);
  });
});

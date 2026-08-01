import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverPageInstagramAccount } from './discovery.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PAGE_ID = 'page-1';
const PAGE_TOKEN = 'page-token';

describe('discoverPageInstagramAccount', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns status=linked with the account for a Business/Creator-linked account', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes(`/${PAGE_ID}`) && urlStr.includes('instagram_business_account')) {
        return jsonResponse({
          instagram_business_account: { id: 'ig-1', username: 'my_business_ig' },
        });
      }
      if (urlStr.includes('/ig-1') && urlStr.includes('account_type')) {
        return jsonResponse({ account_type: 'BUSINESS' });
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverPageInstagramAccount(PAGE_ID, PAGE_TOKEN);
    expect(result).toEqual({
      status: 'linked',
      account: { id: 'ig-1', username: 'my_business_ig' },
    });
  });

  it('returns status=not_linked when the Page has no instagram_business_account field at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );

    const result = await discoverPageInstagramAccount(PAGE_ID, PAGE_TOKEN);
    expect(result).toEqual({ status: 'not_linked' });
  });

  it('returns status=personal_account and rejects it when the linked account is Personal', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes(`/${PAGE_ID}`) && urlStr.includes('instagram_business_account')) {
        return jsonResponse({
          instagram_business_account: { id: 'ig-2', username: 'my_personal_ig' },
        });
      }
      if (urlStr.includes('/ig-2') && urlStr.includes('account_type')) {
        return jsonResponse({ account_type: 'PERSONAL' });
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverPageInstagramAccount(PAGE_ID, PAGE_TOKEN);
    expect(result).toEqual({ status: 'personal_account', accountId: 'ig-2' });
  });

  it('treats a MEDIA_CREATOR account_type as linked, not rejected', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes(`/${PAGE_ID}`) && urlStr.includes('instagram_business_account')) {
        return jsonResponse({
          instagram_business_account: { id: 'ig-3', username: 'my_creator_ig' },
        });
      }
      if (urlStr.includes('/ig-3') && urlStr.includes('account_type')) {
        return jsonResponse({ account_type: 'MEDIA_CREATOR' });
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverPageInstagramAccount(PAGE_ID, PAGE_TOKEN);
    expect(result).toEqual({
      status: 'linked',
      account: { id: 'ig-3', username: 'my_creator_ig' },
    });
  });

  it('fails closed (throws) rather than treating a failed account_type lookup as linked', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlStr = input.toString();
      if (urlStr.includes(`/${PAGE_ID}`) && urlStr.includes('instagram_business_account')) {
        return jsonResponse({
          instagram_business_account: { id: 'ig-4', username: 'my_ig' },
        });
      }
      if (urlStr.includes('/ig-4') && urlStr.includes('account_type')) {
        return jsonResponse({ error: { message: 'temporary error' } }, 500);
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    // A transient failure on the account_type check must not silently accept
    // an unverified account as "linked" — that would defeat the whole point
    // of rejecting Personal accounts. Callers (upsertFacebookTargets.ts,
    // healthCheck.ts) already catch discovery failures and treat them as
    // not_linked, so throwing here is the correct fail-closed behavior.
    await expect(discoverPageInstagramAccount(PAGE_ID, PAGE_TOKEN)).rejects.toThrow();
  });
});

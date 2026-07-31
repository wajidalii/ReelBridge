import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiPost } from '../api/client.js';
import { useConfig } from '../api/useConfig.js';

interface ManualTargetResponse {
  id: string;
  externalId: string;
  displayName: string;
}

const inputClasses =
  'block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm ' +
  'placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30';

export function ConnectFacebook() {
  const [searchParams] = useSearchParams();
  const [pageId, setPageId] = useState('');
  const [name, setName] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const { data: config, isLoading: configLoading } = useConfig();
  const metaApproved = config?.metaAppReviewApproved === true;

  // The initiating click sets ?intent=..., which the OAuth provider does not
  // preserve across the redirect round-trip — the server re-derives it from
  // the signed OAuth state and echoes it back on both success and (where
  // known) error redirects, so this one param covers both cases.
  const intent = searchParams.get('intent') === 'instagram' ? 'instagram' : 'facebook';
  const connected = searchParams.get('connected') === '1';
  const oauthError = searchParams.get('error');
  const pagesFound = Number(searchParams.get('pages') ?? '0');
  const instagramFound = Number(searchParams.get('instagram') ?? '0');
  const noInstagramAccountFound = connected && intent === 'instagram' && instagramFound === 0;
  const noPagesFound = connected && intent === 'facebook' && pagesFound === 0;

  const manualConnect = useMutation({
    mutationFn: () =>
      apiPost<ManualTargetResponse>('/targets/facebook/manual', {
        page_id: pageId,
        name,
        access_token: accessToken,
      }),
  });

  function handleManualSubmit(event: React.FormEvent) {
    event.preventDefault();
    manualConnect.mutate();
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">
        {intent === 'instagram' ? 'Connect Instagram' : 'Connect Facebook'}
      </h1>
      <p className="mt-2 text-slate-600">
        {intent === 'instagram'
          ? "Connect the Facebook Page linked to your Instagram Business account — we'll find the Instagram account automatically."
          : 'Connect a Facebook Page (and any linked Instagram Business account) to start scheduling Reels.'}
      </p>

      {oauthError && (
        <p role="alert" className="mt-4 text-sm font-medium text-red-600">
          {oauthError}
        </p>
      )}

      {connected && !noInstagramAccountFound && !noPagesFound && (
        <p role="status" className="mt-4 text-sm font-medium text-emerald-600">
          {intent === 'instagram'
            ? 'Instagram Business account connected.'
            : `Connected ${pagesFound} Facebook Page${pagesFound === 1 ? '' : 's'}.`}
        </p>
      )}

      {noPagesFound && (
        <p role="status" className="mt-4 text-sm font-medium text-amber-700">
          No Pages were auto-detected. This can happen for Pages under a Business Portfolio —
          use manual entry below.
        </p>
      )}

      {noInstagramAccountFound && (
        <div role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            {pagesFound > 0
              ? "This Facebook Page isn't linked to an Instagram Business account yet."
              : 'No Facebook Page was found to check for a linked Instagram Business account.'}
          </p>
          <p className="mt-2 text-sm text-amber-800">
            Convert the Instagram account you want to use into a professional (Business)
            account and link it to this Facebook Page, then reconnect.{' '}
            <a
              href="https://www.facebook.com/business/help/"
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium underline"
            >
              See Meta&apos;s instructions
            </a>
            .
          </p>
        </div>
      )}

      {intent === 'facebook' && (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {!configLoading && !metaApproved ? (
            <p className="text-sm font-medium text-amber-700">
              Connecting with Facebook is currently invite-only while we complete Meta&apos;s App
              Review. Use manual entry below in the meantime.
            </p>
          ) : (
            <button
              type="button"
              onClick={() => (window.location.href = '/api/connections/facebook/start?intent=facebook')}
              className="inline-flex items-center rounded-lg bg-[#1877f2] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#1364d6]"
            >
              Connect with Facebook
            </button>
          )}
        </div>
      )}

      {intent === 'instagram' && (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {!configLoading && !metaApproved ? (
            <p className="text-sm font-medium text-amber-700">
              Connecting Instagram is currently invite-only while we complete Meta&apos;s App
              Review. Check back once that clears.
            </p>
          ) : (
            <>
              <button
                type="button"
                onClick={() =>
                  (window.location.href = '/api/connections/facebook/start?intent=instagram')
                }
                className="inline-flex items-center rounded-lg bg-[#1877f2] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#1364d6]"
              >
                Connect with Facebook
              </button>
              <p className="mt-3 text-sm text-slate-500">
                Instagram doesn&apos;t yet support manual connection — use the button above and
                we&apos;ll automatically detect any Instagram Business account linked to the Page
                you choose.
              </p>
            </>
          )}
        </div>
      )}

      {/* Always shown for the Facebook intent, not just when auto-discovery comes back
          empty — Pages under a Business Portfolio can be under-reported by /me/accounts
          (SAAS_PLAN.md). Instagram has no manual-entry equivalent, so this section is
          Facebook-only. */}
      {intent === 'facebook' && (
      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Or connect a Page manually</h2>

        <form onSubmit={handleManualSubmit} className="mt-4 space-y-4" autoComplete="off">
          <div>
            <label htmlFor="page-id" className="block text-sm font-medium text-slate-700">
              Page ID
            </label>
            <input
              id="page-id"
              className={`mt-1 ${inputClasses}`}
              value={pageId}
              onChange={(event) => setPageId(event.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <div>
            <label htmlFor="page-name" className="block text-sm font-medium text-slate-700">
              Page name
            </label>
            <input
              id="page-name"
              className={`mt-1 ${inputClasses}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <div>
            <label htmlFor="page-token" className="block text-sm font-medium text-slate-700">
              Page access token
            </label>
            <input
              id="page-token"
              type="password"
              className={`mt-1 font-mono ${inputClasses}`}
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <button
            type="submit"
            disabled={manualConnect.isPending}
            className="inline-flex items-center rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {manualConnect.isPending ? 'Connecting…' : 'Connect manually'}
          </button>
        </form>

        {manualConnect.isError && (
          <p role="alert" className="mt-4 text-sm font-medium text-red-600">
            {manualConnect.error instanceof Error
              ? manualConnect.error.message
              : 'Connection failed.'}
          </p>
        )}
        {manualConnect.isSuccess && (
          <p role="status" className="mt-4 text-sm font-medium text-emerald-600">
            Connected {manualConnect.data.displayName}.
          </p>
        )}

        <details className="mt-6 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
          <summary className="cursor-pointer font-medium text-slate-900">
            How do I get a Page access token?
          </summary>
          <ol className="mt-3 list-decimal space-y-2 pl-5">
            <li>
              In the{' '}
              <a
                href="https://developers.facebook.com/apps"
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-brand-600 hover:underline"
              >
                Meta App Dashboard
              </a>
              , open your app and add the &quot;Manage everything on your Page&quot; use case — this
              is what makes{' '}
              <code className="rounded bg-slate-200 px-1 py-0.5 text-xs">pages_manage_posts</code>{' '}
              selectable at all.
            </li>
            <li>
              Open{' '}
              <a
                href="https://developers.facebook.com/tools/explorer/"
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-brand-600 hover:underline"
              >
                Graph API Explorer
              </a>
              , select your app, and request the{' '}
              <code className="rounded bg-slate-200 px-1 py-0.5 text-xs">pages_show_list</code>,{' '}
              <code className="rounded bg-slate-200 px-1 py-0.5 text-xs">
                pages_read_engagement
              </code>
              , <code className="rounded bg-slate-200 px-1 py-0.5 text-xs">pages_manage_posts</code>
              , and{' '}
              <code className="rounded bg-slate-200 px-1 py-0.5 text-xs">business_management</code>{' '}
              scopes.
            </li>
            <li>
              Generate a User Access Token, then call{' '}
              <code className="rounded bg-slate-200 px-1 py-0.5 text-xs">GET /me/accounts</code> to
              find your Page and its short-lived Page access token.
            </li>
            <li>
              Exchange it for a long-lived token:{' '}
              <code className="rounded bg-slate-200 px-1 py-0.5 text-xs">
                GET /oauth/access_token
              </code>{' '}
              with{' '}
              <code className="rounded bg-slate-200 px-1 py-0.5 text-xs">
                grant_type=fb_exchange_token
              </code>
              . Paste the resulting token above.
            </li>
          </ol>
        </details>
      </div>
      )}
    </div>
  );
}

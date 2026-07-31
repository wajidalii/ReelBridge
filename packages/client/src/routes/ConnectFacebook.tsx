import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { apiPost } from '../api/client.js';

interface ManualTargetResponse {
  id: string;
  externalId: string;
  displayName: string;
}

const inputClasses =
  'block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm ' +
  'placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30';

export function ConnectFacebook() {
  const [pageId, setPageId] = useState('');
  const [name, setName] = useState('');
  const [accessToken, setAccessToken] = useState('');

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
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Connect Facebook</h1>
      <p className="mt-2 text-slate-600">
        Connect a Facebook Page (and any linked Instagram Business account) to start scheduling
        Reels.
      </p>

      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <button
          type="button"
          onClick={() => (window.location.href = '/api/connections/facebook/start')}
          className="inline-flex items-center rounded-lg bg-[#1877f2] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#1364d6]"
        >
          Connect with Facebook
        </button>
      </div>

      {/* Always shown, not just when auto-discovery comes back empty — Pages under a
          Business Portfolio can be under-reported by /me/accounts (SAAS_PLAN.md). */}
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
    </div>
  );
}

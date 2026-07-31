import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { apiPost } from '../api/client.js';

interface ManualTargetResponse {
  id: string;
  externalId: string;
  displayName: string;
}

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
    <section>
      <h1>Connect Facebook</h1>

      <p>
        Connect a Facebook Page (and any linked Instagram Business account) to start scheduling
        Reels.
      </p>

      <button
        type="button"
        onClick={() => (window.location.href = '/api/connections/facebook/start')}
      >
        Connect with Facebook
      </button>

      {/* Always shown, not just when auto-discovery comes back empty — Pages under a
          Business Portfolio can be under-reported by /me/accounts (SAAS_PLAN.md). */}
      <div style={{ marginTop: '2rem' }}>
        <h2>Or connect a Page manually</h2>

        <form onSubmit={handleManualSubmit}>
          <div>
            <label htmlFor="page-id">Page ID</label>
            <input
              id="page-id"
              value={pageId}
              onChange={(event) => setPageId(event.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="page-name">Page name</label>
            <input
              id="page-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="page-token">Page access token</label>
            <input
              id="page-token"
              type="password"
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
              required
            />
          </div>
          <button type="submit" disabled={manualConnect.isPending}>
            {manualConnect.isPending ? 'Connecting…' : 'Connect manually'}
          </button>
        </form>

        {manualConnect.isError && (
          <p role="alert" style={{ color: 'crimson' }}>
            {manualConnect.error instanceof Error
              ? manualConnect.error.message
              : 'Connection failed.'}
          </p>
        )}
        {manualConnect.isSuccess && (
          <p role="status" style={{ color: 'green' }}>
            Connected {manualConnect.data.displayName}.
          </p>
        )}

        <details style={{ marginTop: '1rem' }}>
          <summary>How do I get a Page access token?</summary>
          <ol>
            <li>
              In the{' '}
              <a
                href="https://developers.facebook.com/apps"
                target="_blank"
                rel="noreferrer noopener"
              >
                Meta App Dashboard
              </a>
              , open your app and add the &quot;Manage everything on your Page&quot; use case — this
              is what makes <code>pages_manage_posts</code> selectable at all.
            </li>
            <li>
              Open{' '}
              <a
                href="https://developers.facebook.com/tools/explorer/"
                target="_blank"
                rel="noreferrer noopener"
              >
                Graph API Explorer
              </a>
              , select your app, and request the <code>pages_show_list</code>,{' '}
              <code>pages_read_engagement</code>, <code>pages_manage_posts</code>, and{' '}
              <code>business_management</code> scopes.
            </li>
            <li>
              Generate a User Access Token, then call <code>GET /me/accounts</code> to find your
              Page and its short-lived Page access token.
            </li>
            <li>
              Exchange it for a long-lived token: <code>GET /oauth/access_token</code> with{' '}
              <code>grant_type=fb_exchange_token</code>. Paste the resulting token above.
            </li>
          </ol>
        </details>
      </div>
    </section>
  );
}

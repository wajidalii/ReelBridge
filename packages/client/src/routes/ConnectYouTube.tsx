import { useSearchParams } from 'react-router-dom';
import { useConfig } from '../api/useConfig.js';
import { cardClasses } from '../components/ui.js';

export function YouTubePrivateOnlyNotice() {
  return (
    <p role="note" className="text-sm font-medium text-amber-700">
      Uploads via ReelBridge will currently only be published as private on YouTube until our API
      access is fully verified.
    </p>
  );
}

export function ConnectYouTube() {
  const [searchParams] = useSearchParams();
  const { data: config, isLoading: configLoading } = useConfig();
  const connected = searchParams.get('connected') === '1';
  const oauthError = searchParams.get('error');
  const channelsFound = Number(searchParams.get('channels') ?? '0');
  const youtubeApproved = config?.youtubeComplianceApproved === true;

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Connect YouTube</h1>
      <p className="mt-2 text-slate-600">
        Connect a Google account to post Reels as Shorts on the YouTube channels it manages.
      </p>

      {oauthError && (
        <p role="alert" className="mt-4 text-sm font-medium text-red-600">
          {oauthError}
        </p>
      )}

      {connected && channelsFound > 0 && (
        <p role="status" aria-live="polite" className="mt-4 text-sm font-medium text-emerald-600">
          Connected {channelsFound} YouTube channel{channelsFound === 1 ? '' : 's'}.
        </p>
      )}
      {connected && channelsFound === 0 && (
        <p role="status" aria-live="polite" className="mt-4 text-sm font-medium text-amber-700">
          Google authorized, but no YouTube channel was found on that account. Make sure the Google
          account you picked owns or manages a channel, then try again.
        </p>
      )}

      <div className={`mt-6 ${cardClasses}`}>
        {!configLoading && !youtubeApproved && (
          <div className="mb-4">
            <YouTubePrivateOnlyNotice />
          </div>
        )}
        <button
          type="button"
          onClick={() => (window.location.href = '/api/connections/google/start')}
          className="inline-flex items-center rounded-lg bg-[#ff0000] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#d90000]"
        >
          Connect with Google
        </button>
        <p className="mt-3 text-sm text-slate-500">
          You&apos;ll be asked to grant the{' '}
          <code className="rounded bg-slate-200 px-1 py-0.5 text-xs">youtube.upload</code>{' '}
          permission only — ReelBridge never needs to read your channel or comments.
        </p>
      </div>
    </div>
  );
}

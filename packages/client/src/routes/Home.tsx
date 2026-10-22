import type { PlatformType } from '@reelbridge/shared';
import { Link } from 'react-router-dom';
import { useDashboard } from '../api/dashboard.js';
import type { PostTargetStatus } from '../api/posts.js';
import { useTargets } from '../api/targets.js';
import {
  cardClasses,
  errorMessage,
  PLATFORM_LABELS,
  primaryButtonClasses,
} from '../components/ui.js';
import { Onboarding } from './Onboarding.js';

const STATUS_LABELS: Record<PostTargetStatus, string> = {
  pending: 'Pending',
  queued: 'Queued',
  uploading: 'Uploading',
  native_scheduled: 'Scheduled (platform)',
  awaiting_app_managed_publish: 'Scheduled (ReelBridge)',
  published: 'Published',
  failed: 'Failed',
};
const STATUS_ORDER = Object.keys(STATUS_LABELS) as PostTargetStatus[];
const PLATFORM_ORDER: PlatformType[] = ['facebook_page', 'instagram_business', 'youtube_channel'];

function Dashboard() {
  const { data, isLoading, isError, error } = useDashboard();

  if (isLoading) {
    return (
      <p role="status" aria-live="polite" className="text-sm text-slate-500">
        Loading your overview…
      </p>
    );
  }
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm font-medium text-red-600">
        {errorMessage(error, 'Could not load your overview.')}
      </p>
    );
  }

  const platformsWithPosts = PLATFORM_ORDER.filter((p) => data.posts.countsByPlatform[p]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Overview</h1>
          <p className="mt-2 text-slate-600">
            {data.targets.active} of {data.targets.total} connected target
            {data.targets.total === 1 ? '' : 's'} healthy · {data.batches.total} batch
            {data.batches.total === 1 ? '' : 'es'}
          </p>
        </div>
        <div className="flex gap-3">
          <Link to="/upload" className={primaryButtonClasses}>
            New batch
          </Link>
          <Link
            to="/posts"
            className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Dashboard
          </Link>
        </div>
      </div>

      {data.targets.needsAttention.length > 0 && (
        <section
          aria-labelledby="needs-attention-heading"
          className="rounded-xl border border-amber-200 bg-amber-50 p-5"
        >
          <h2 id="needs-attention-heading" className="text-base font-semibold text-amber-900">
            {data.targets.needsAttention.length} target
            {data.targets.needsAttention.length === 1 ? ' needs' : 's need'} reconnecting
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-amber-900">
            {data.targets.needsAttention.map((target) => (
              <li key={target.id}>
                {PLATFORM_LABELS[target.platform]}: {target.displayName}
              </li>
            ))}
          </ul>
          <Link
            to="/settings"
            className="mt-3 inline-block text-sm font-medium text-amber-900 underline"
          >
            Open settings to reconnect
          </Link>
        </section>
      )}

      <section aria-labelledby="targets-heading" className={cardClasses}>
        <h2 id="targets-heading" className="text-base font-semibold text-slate-900">
          Connected targets
        </h2>
        <dl className="mt-3 grid gap-4 sm:grid-cols-3">
          {PLATFORM_ORDER.map((platform) => (
            <div key={platform} className="rounded-lg bg-slate-50 p-3">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {PLATFORM_LABELS[platform]}
              </dt>
              <dd className="mt-1 text-2xl font-semibold text-slate-900">
                {data.targets.byPlatform[platform] ?? 0}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="posts-heading" className={cardClasses}>
        <h2 id="posts-heading" className="text-base font-semibold text-slate-900">
          Posts by platform and status
        </h2>
        {platformsWithPosts.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">
            Nothing scheduled yet.{' '}
            <Link to="/upload" className="font-medium text-brand-600 hover:underline">
              Upload your first batch
            </Link>
            .
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  <th scope="col" className="py-2 pr-4">
                    Platform
                  </th>
                  {STATUS_ORDER.map((status) => (
                    <th scope="col" key={status} className="py-2 pr-4">
                      {STATUS_LABELS[status]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {platformsWithPosts.map((platform) => (
                  <tr key={platform} className="border-t border-slate-100">
                    <th scope="row" className="py-2 pr-4 text-left font-medium text-slate-900">
                      {PLATFORM_LABELS[platform]}
                    </th>
                    {STATUS_ORDER.map((status) => (
                      <td key={status} className="py-2 pr-4 tabular-nums text-slate-700">
                        {data.posts.countsByPlatform[platform]?.[status] ?? 0}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="upcoming-heading" className={cardClasses}>
          <h2 id="upcoming-heading" className="text-base font-semibold text-slate-900">
            Upcoming
          </h2>
          {data.upcoming.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">No scheduled posts coming up.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {data.upcoming.map((post) => (
                <li key={post.id} className="py-2 text-sm">
                  <p className="font-medium text-slate-900">
                    {post.originalFilename ?? 'Video'}{' '}
                    <span className="font-normal text-slate-500">
                      → {PLATFORM_LABELS[post.platform]}: {post.targetDisplayName}
                    </span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : '—'} ·{' '}
                    {STATUS_LABELS[post.status]}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="failures-heading" className={cardClasses}>
          <h2 id="failures-heading" className="text-base font-semibold text-slate-900">
            Recent failures
          </h2>
          {data.recentFailures.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">No failed posts. Nice.</p>
          ) : (
            <>
              <ul className="mt-3 divide-y divide-slate-100">
                {data.recentFailures.map((post) => (
                  <li key={post.id} className="py-2 text-sm">
                    <p className="font-medium text-slate-900">
                      {post.originalFilename ?? 'Video'}{' '}
                      <span className="font-normal text-slate-500">
                        → {PLATFORM_LABELS[post.platform]}: {post.targetDisplayName}
                      </span>
                    </p>
                    {post.lastError && <p className="text-xs text-red-700">{post.lastError}</p>}
                  </li>
                ))}
              </ul>
              <Link
                to="/posts?status=failed"
                className="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline"
              >
                View all failed posts
              </Link>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export function Home() {
  const { data: targets, isLoading, isError, error } = useTargets();

  if (isLoading) {
    return (
      <p role="status" aria-live="polite" className="text-sm text-slate-500">
        Loading…
      </p>
    );
  }
  if (isError) {
    return (
      <p role="alert" className="text-sm font-medium text-red-600">
        {errorMessage(error, 'Could not load your targets.')}
      </p>
    );
  }
  if (!targets || targets.length === 0) {
    return <Onboarding />;
  }
  return <Dashboard />;
}

import type { PlatformType } from '@reelbridge/shared';
import { useMemo, useState } from 'react';
import { useTargets } from '../api/targets.js';
import {
  usePosts,
  useRetryPost,
  type Post,
  type PostsFilters,
  type PostTargetStatus,
} from '../api/posts.js';

const PLATFORM_LABELS: Record<PlatformType, string> = {
  facebook_page: 'Facebook',
  instagram_business: 'Instagram',
  youtube_channel: 'YouTube',
};

const STATUS_FILTER_OPTIONS: PostTargetStatus[] = [
  'pending',
  'queued',
  'uploading',
  'native_scheduled',
  'awaiting_app_managed_publish',
  'published',
  'failed',
];

// Icon glyphs are decorative — the accessible distinction is the text label
// next to them (design.md §9: status must be conveyed by text, not color/
// icon alone). native_scheduled vs. awaiting_app_managed_publish in
// particular carry different reliability expectations the user should learn
// to read at a glance, so those two get their own icon+label pair rather
// than sharing a generic "Scheduled" badge.
function StatusBadge({ status }: { status: PostTargetStatus }) {
  const badgeClasses =
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold';
  switch (status) {
    case 'native_scheduled':
      return (
        <span className={`${badgeClasses} border border-sky-200 bg-sky-50 text-sky-700`}>
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-12a.75.75 0 00-1.5 0v4c0 .2.08.39.22.53l2.5 2.5a.75.75 0 101.06-1.06L10.75 9.7V6z"
              clipRule="evenodd"
            />
          </svg>
          Scheduled — platform will publish
        </span>
      );
    case 'awaiting_app_managed_publish':
      return (
        <span className={`${badgeClasses} border border-violet-200 bg-violet-50 text-violet-700`}>
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M11.983 1.907a.75.75 0 00-1.292-.657L4.75 9.75a.75.75 0 00.573 1.223h4.199l-1.505 6.313a.75.75 0 001.292.657l5.941-8.5a.75.75 0 00-.573-1.223H10.48l1.503-6.313z" />
          </svg>
          Scheduled — ReelBridge will publish
        </span>
      );
    case 'published':
      return (
        <span
          className={`${badgeClasses} border border-emerald-200 bg-emerald-50 text-emerald-700`}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
              clipRule="evenodd"
            />
          </svg>
          Published
        </span>
      );
    case 'failed':
      return (
        <span className={`${badgeClasses} border border-red-200 bg-red-50 text-red-700`}>
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 8a1 1 0 100-2 1 1 0 000 2z"
              clipRule="evenodd"
            />
          </svg>
          Failed
        </span>
      );
    case 'uploading':
      return (
        <span className={`${badgeClasses} border border-slate-200 bg-slate-100 text-slate-600`}>
          Uploading
        </span>
      );
    case 'queued':
      return (
        <span className={`${badgeClasses} border border-slate-200 bg-slate-100 text-slate-600`}>
          Queued
        </span>
      );
    case 'pending':
    default:
      return (
        <span className={`${badgeClasses} border border-slate-200 bg-slate-100 text-slate-600`}>
          Pending
        </span>
      );
  }
}

function whenLabel(post: Post): string {
  if (post.status === 'published' && post.publishedAt) {
    return new Date(post.publishedAt).toLocaleString();
  }
  if (post.scheduledAt) {
    return new Date(post.scheduledAt).toLocaleString();
  }
  return '—';
}

const selectClasses =
  'block rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 shadow-sm ' +
  'focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30';

function RetryButton({ postId }: { postId: string }) {
  const retry = useRetryPost();
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => retry.mutate(postId)}
        disabled={retry.isPending}
        className="inline-flex items-center rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {retry.isPending ? 'Retrying…' : 'Retry'}
      </button>
      {retry.isError && (
        <p role="alert" className="mt-1 text-xs font-medium text-red-600">
          {retry.error instanceof Error ? retry.error.message : 'Retry failed.'}
        </p>
      )}
    </div>
  );
}

export function PostsDashboard() {
  const { data: targets } = useTargets();
  const [platform, setPlatform] = useState<PlatformType | ''>('');
  const [status, setStatus] = useState<PostTargetStatus | ''>('');
  const [target, setTarget] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const filters: PostsFilters = useMemo(
    () => ({
      platform: platform || undefined,
      status: status || undefined,
      target: target || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
    }),
    [platform, status, target, from, to],
  );

  const { data, isLoading, isError, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    usePosts(filters);

  const posts = useMemo(() => data?.pages.flatMap((page) => page.posts) ?? [], [data]);

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Status dashboard</h1>
      <p className="mt-2 text-slate-600">
        Every post across platforms, filterable by platform, target, status, and date.
      </p>

      <div className="mt-6 flex flex-wrap items-end gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div>
          <label htmlFor="filter-platform" className="block text-xs font-medium text-slate-700">
            Platform
          </label>
          <select
            id="filter-platform"
            className={`mt-1 ${selectClasses}`}
            value={platform}
            onChange={(event) => setPlatform(event.target.value as PlatformType | '')}
          >
            <option value="">All platforms</option>
            {(Object.keys(PLATFORM_LABELS) as PlatformType[]).map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABELS[p]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="filter-status" className="block text-xs font-medium text-slate-700">
            Status
          </label>
          <select
            id="filter-status"
            className={`mt-1 ${selectClasses}`}
            value={status}
            onChange={(event) => setStatus(event.target.value as PostTargetStatus | '')}
          >
            <option value="">All statuses</option>
            {STATUS_FILTER_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="filter-target" className="block text-xs font-medium text-slate-700">
            Target
          </label>
          <select
            id="filter-target"
            className={`mt-1 ${selectClasses}`}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">All targets</option>
            {(targets ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="filter-from" className="block text-xs font-medium text-slate-700">
            From
          </label>
          <input
            id="filter-from"
            type="date"
            className={`mt-1 ${selectClasses}`}
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>

        <div>
          <label htmlFor="filter-to" className="block text-xs font-medium text-slate-700">
            To
          </label>
          <input
            id="filter-to"
            type="date"
            className={`mt-1 ${selectClasses}`}
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
      </div>

      {isLoading && <p className="mt-6 text-slate-600">Loading…</p>}
      {isError && (
        <p role="alert" className="mt-6 text-sm font-medium text-red-600">
          {error instanceof Error ? error.message : 'Failed to load posts.'}
        </p>
      )}

      {!isLoading && !isError && posts.length === 0 && (
        <p className="mt-6 text-sm text-slate-500">No posts match these filters.</p>
      )}

      {posts.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold text-slate-700"
                >
                  Video
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold text-slate-700"
                >
                  Target
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold text-slate-700"
                >
                  Status
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold text-slate-700"
                >
                  When
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {posts.map((post) => (
                <tr key={post.id} className={post.status === 'failed' ? 'bg-red-50/40' : undefined}>
                  <td className="px-4 py-3 align-top text-sm font-medium text-slate-900">
                    {post.originalFilename ?? 'Unknown file'}
                    {post.caption && (
                      <p className="mt-1 max-w-xs whitespace-pre-wrap text-xs font-normal text-slate-500">
                        {post.caption}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top text-sm text-slate-700">
                    <p className="font-medium text-slate-900">{post.targetDisplayName}</p>
                    <p className="text-xs text-slate-500">{PLATFORM_LABELS[post.platform]}</p>
                  </td>
                  <td className="px-4 py-3 align-top text-sm">
                    <StatusBadge status={post.status} />
                    {post.status === 'failed' && (
                      <>
                        {post.lastError && (
                          <p className="mt-1.5 max-w-xs text-xs text-red-700">{post.lastError}</p>
                        )}
                        <RetryButton postId={post.id} />
                      </>
                    )}
                    {post.status === 'published' && post.permalinkUrl && (
                      <a
                        href={post.permalinkUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1.5 block text-xs font-medium text-brand-600 hover:underline"
                      >
                        View post →
                      </a>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top text-sm text-slate-700">{whenLabel(post)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasNextPage && (
        <button
          type="button"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
          className="mt-6 inline-flex items-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

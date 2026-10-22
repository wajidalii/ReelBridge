import type { PlatformType } from '@reelbridge/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useUsage } from '../api/billing.js';
import { useConnections, useDeleteConnection } from '../api/connections.js';
import {
  useDeleteTarget,
  useRevalidateTarget,
  useTargets,
  type Target,
  type TargetHealth,
} from '../api/targets.js';
import { InlineConfirm } from '../components/InlineConfirm.js';
import { ScheduleConfigPanel } from '../components/ScheduleConfigPanel.js';
import {
  cardClasses,
  errorMessage,
  PLATFORM_LABELS,
  relativeTime,
  secondaryButtonClasses,
} from '../components/ui.js';

const PLATFORM_ORDER: PlatformType[] = ['facebook_page', 'instagram_business', 'youtube_channel'];

const HEALTH_LABELS: Record<TargetHealth, { label: string; classes: string }> = {
  healthy: { label: 'Healthy', classes: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  needs_reconnect: {
    label: 'Needs reconnect',
    classes: 'border-amber-200 bg-amber-50 text-amber-800',
  },
  revoked: { label: 'Access revoked', classes: 'border-red-200 bg-red-50 text-red-700' },
  unchecked: { label: 'Not yet checked', classes: 'border-slate-200 bg-slate-100 text-slate-600' },
};

function HealthBadge({ health }: { health: TargetHealth }) {
  const { label, classes } = HEALTH_LABELS[health];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${classes}`}
    >
      {label}
    </span>
  );
}

function reconnectPath(platform: PlatformType): string {
  if (platform === 'youtube_channel') return '/connect/youtube';
  if (platform === 'instagram_business') return '/connect/facebook?intent=instagram';
  return '/connect/facebook?intent=facebook';
}

function TargetRow({ target }: { target: Target }) {
  const revalidate = useRevalidateTarget();
  const deleteTarget = useDeleteTarget();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const statusId = `target-${target.id}-status`;
  const needsReconnect = target.health === 'needs_reconnect' || target.health === 'revoked';

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-slate-900">
            {target.displayName}
            {target.username && <span className="text-slate-500"> @{target.username}</span>}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <HealthBadge health={target.health} />
            <span>Last checked {relativeTime(target.lastValidatedAt)}</span>
            <span>· Connected {new Date(target.connectedAt).toLocaleDateString()}</span>
            {target.tokenSource === 'manual' && <span>· Manual token</span>}
          </p>
          {target.lastHealthError && (
            <p className="mt-1 text-xs text-red-700">{target.lastHealthError}</p>
          )}
          {!target.capabilities.nativeScheduling && (
            <p className="mt-1 text-xs text-slate-500">
              Scheduling is ReelBridge-managed on this platform: we trigger each post at its
              scheduled time rather than the platform holding it.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {needsReconnect && (
            <Link
              to={reconnectPath(target.platform)}
              className="inline-flex items-center rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
            >
              Reconnect
            </Link>
          )}
          <button
            type="button"
            className={secondaryButtonClasses}
            disabled={revalidate.isPending}
            onClick={() => revalidate.mutate(target.id)}
            aria-describedby={statusId}
          >
            {revalidate.isPending ? 'Queuing…' : 'Revalidate'}
          </button>
          <button
            type="button"
            className={secondaryButtonClasses}
            aria-expanded={scheduleOpen}
            aria-controls={`schedule-${target.id}`}
            onClick={() => setScheduleOpen((open) => !open)}
          >
            {scheduleOpen ? 'Hide schedule' : 'Recurring schedule'}
          </button>
          <InlineConfirm
            label="Disconnect"
            confirmLabel="Disconnect target"
            description="Pending posts to this target will be removed."
            pending={deleteTarget.isPending}
            onConfirm={() => deleteTarget.mutate(target.id)}
          />
        </div>
      </div>
      <p id={statusId} role="status" aria-live="polite" className="mt-2 text-xs">
        {revalidate.isSuccess && (
          <span className="font-medium text-emerald-700">
            Check queued — the health state updates once the worker has run it.
          </span>
        )}
        {revalidate.isError && (
          <span className="font-medium text-red-600">
            {errorMessage(revalidate.error, 'Could not queue the check.')}
          </span>
        )}
        {deleteTarget.isError && (
          <span className="font-medium text-red-600">
            {errorMessage(deleteTarget.error, 'Could not disconnect.')}
          </span>
        )}
      </p>
      {scheduleOpen && (
        <div id={`schedule-${target.id}`} className="mt-4">
          <ScheduleConfigPanel target={target} />
        </div>
      )}
    </li>
  );
}

function ConnectionsSection() {
  const { data: connections, isLoading, isError, error } = useConnections();
  const deleteConnection = useDeleteConnection();
  const labels: Record<string, string> = { facebook: 'Facebook (Meta)', google: 'Google' };
  const statusLabels: Record<string, string> = {
    active: 'Active',
    expired: 'Expired',
    revoked: 'Revoked',
  };

  return (
    <section aria-labelledby="connections-heading" className={cardClasses}>
      <h2 id="connections-heading" className="text-base font-semibold text-slate-900">
        Connections
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        The provider logins your targets hang off. Removing one disconnects every target under it.
      </p>
      {isLoading && (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-slate-500">
          Loading…
        </p>
      )}
      {isError && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-600">
          {errorMessage(error, 'Could not load connections.')}
        </p>
      )}
      {deleteConnection.isError && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-600">
          {errorMessage(deleteConnection.error, 'Could not remove the connection.')}
        </p>
      )}
      {connections && connections.length === 0 && (
        <p className="mt-3 text-sm text-slate-600">No connections yet.</p>
      )}
      {connections && connections.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100">
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div>
                <p className="text-sm font-medium text-slate-900">
                  {labels[connection.platform] ?? connection.platform}
                  <span className="text-slate-500"> · {connection.displayName}</span>
                </p>
                <p className="text-xs text-slate-500">
                  Status: {statusLabels[connection.status] ?? connection.status} ·{' '}
                  {connection.targetCount} active target{connection.targetCount === 1 ? '' : 's'}
                </p>
              </div>
              <InlineConfirm
                label="Remove connection"
                confirmLabel="Remove"
                description="All targets under it will be disconnected."
                pending={deleteConnection.isPending && deleteConnection.variables === connection.id}
                onConfirm={() => deleteConnection.mutate(connection.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function UsageSection() {
  const { data: usage, isLoading, isError, error } = useUsage();
  return (
    <section aria-labelledby="usage-heading" className={cardClasses}>
      <h2 id="usage-heading" className="text-base font-semibold text-slate-900">
        Plan &amp; usage
      </h2>
      {isLoading && (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-slate-500">
          Loading…
        </p>
      )}
      {isError && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-600">
          {errorMessage(error, 'Could not load usage.')}
        </p>
      )}
      {usage && (
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Plan</dt>
            <dd className="mt-1 font-medium text-slate-900">{usage.plan.name}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Targets</dt>
            <dd className="mt-1 font-medium text-slate-900">
              {usage.activeTargets} of {usage.plan.maxTargets}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Posts this month
            </dt>
            <dd className="mt-1 font-medium text-slate-900">
              {usage.postsThisMonth} of {usage.plan.maxPostsPerMonth}
            </dd>
          </div>
          {!usage.enforced && (
            <p className="text-xs text-slate-500 sm:col-span-3">
              Limits are not enforced yet during early access.
            </p>
          )}
        </dl>
      )}
    </section>
  );
}

export function Settings() {
  const { data: targets, isLoading, isError, error } = useTargets();

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Settings</h1>
        <p className="mt-2 text-slate-600">
          Account health for every connected target, plus your connections and plan.
        </p>
      </div>

      <section aria-labelledby="targets-heading" className={cardClasses}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="targets-heading" className="text-base font-semibold text-slate-900">
            Connected targets
          </h2>
          <div className="flex gap-3 text-sm">
            <Link
              to="/connect/facebook?intent=facebook"
              className="font-medium text-brand-600 hover:underline"
            >
              Add Facebook
            </Link>
            <Link
              to="/connect/facebook?intent=instagram"
              className="font-medium text-brand-600 hover:underline"
            >
              Add Instagram
            </Link>
            <Link to="/connect/youtube" className="font-medium text-brand-600 hover:underline">
              Add YouTube
            </Link>
          </div>
        </div>
        {isLoading && (
          <p role="status" aria-live="polite" className="mt-3 text-sm text-slate-500">
            Loading targets…
          </p>
        )}
        {isError && (
          <p role="alert" className="mt-3 text-sm font-medium text-red-600">
            {errorMessage(error, 'Could not load targets.')}
          </p>
        )}
        {targets && targets.length === 0 && (
          <p className="mt-3 text-sm text-slate-600">
            Nothing connected yet.{' '}
            <Link to="/" className="font-medium text-brand-600 hover:underline">
              Connect a platform
            </Link>
            .
          </p>
        )}
        {targets &&
          PLATFORM_ORDER.map((platform) => {
            const group = targets.filter((target) => target.platform === platform);
            if (group.length === 0) return null;
            return (
              <div key={platform} className="mt-5">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  {PLATFORM_LABELS[platform]}
                </h3>
                <ul className="divide-y divide-slate-100">
                  {group.map((target) => (
                    <TargetRow key={target.id} target={target} />
                  ))}
                </ul>
              </div>
            );
          })}
      </section>

      <ConnectionsSection />
      <UsageSection />
    </div>
  );
}

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { publishBatch, usePreview, type PreviewRow, type PublishBatchResponse } from '../api/batches.js';

const PLATFORM_LABELS: Record<string, string> = {
  facebook_page: 'Facebook',
  instagram_business: 'Instagram',
  youtube_channel: 'YouTube',
};

function platformLabel(platform: string | null): string {
  if (!platform) return 'Unknown platform';
  return PLATFORM_LABELS[platform] ?? platform;
}

function scheduledAtLabel(row: PreviewRow): string {
  return row.scheduledAt ? new Date(row.scheduledAt).toLocaleString() : 'Publishing now';
}

export function BatchPreview() {
  const { batchId } = useParams<{ batchId: string }>();
  const { data: preview, isLoading: previewLoading } = usePreview(batchId);
  const queryClient = useQueryClient();

  const [acknowledged, setAcknowledged] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<PublishBatchResponse | null>(null);

  // Resets the acknowledgement checkbox whenever the resolved rows/warnings
  // actually change (e.g. after a refetch following a 409), so a previously
  // ticked box can't silently carry forward past a change in what it was
  // acknowledging.
  const warningsSignature = useMemo(
    () =>
      JSON.stringify(
        (preview?.rows ?? []).map((row) => ({
          id: row.id,
          blocking: row.blocking,
          warnings: row.warnings,
        })),
      ),
    [preview],
  );
  const previousSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (previousSignatureRef.current !== null && previousSignatureRef.current !== warningsSignature) {
      setAcknowledged(false);
    }
    previousSignatureRef.current = warningsSignature;
  }, [warningsSignature]);

  if (previewLoading) {
    return <p className="text-slate-600">Loading…</p>;
  }
  if (!preview) {
    return <p className="text-red-600">Batch not found.</p>;
  }

  const { rows } = preview;
  const hasBlocking = rows.some((row) => row.blocking);
  const hasNonBlockingWarnings = rows.some((row) => !row.blocking && row.warnings.length > 0);
  const publishDisabled =
    hasBlocking || (hasNonBlockingWarnings && !acknowledged) || publishing || rows.length === 0;

  async function handlePublish() {
    if (!batchId) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await publishBatch(batchId);
      setPublishResult(result);
      await queryClient.invalidateQueries({ queryKey: ['batch-preview', batchId] });
      await queryClient.invalidateQueries({ queryKey: ['batch', batchId] });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to schedule batch.';
      setPublishError(message);
      if (err instanceof ApiError && err.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ['batch-preview', batchId] });
      }
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">
        Preview & schedule — {preview.batchName}
      </h1>
      <p className="mt-2 text-slate-600">
        Review every video/target combination below before scheduling. Rows with blocking issues
        must be fixed first; rows with only warnings can be acknowledged and scheduled anyway.
      </p>

      {rows.length === 0 && (
        <p className="mt-6 text-sm text-slate-500">
          No targets have been assigned yet — go back and assign at least one target to preview
          it here.
        </p>
      )}

      {rows.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-700">
                  Video
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-700">
                  Target
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-700">
                  Caption / title
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-700">
                  When
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-700">
                  Warnings
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={
                    row.blocking
                      ? 'bg-red-50/50'
                      : row.warnings.length > 0
                        ? 'bg-amber-50/50'
                        : undefined
                  }
                >
                  <td className="px-4 py-3 align-top text-sm font-medium text-slate-900">
                    {row.originalFilename ?? 'Unknown file'}
                  </td>
                  <td className="px-4 py-3 align-top text-sm text-slate-700">
                    <p className="font-medium text-slate-900">
                      {row.targetDisplayName ?? 'Unknown target'}
                    </p>
                    <p className="text-xs text-slate-500">{platformLabel(row.platform)}</p>
                  </td>
                  <td className="px-4 py-3 align-top text-sm text-slate-700">
                    <p className="max-w-xs whitespace-pre-wrap">{row.resolvedCaption}</p>
                    {row.resolvedTitle && (
                      <p className="mt-1 text-xs text-slate-500">Title: {row.resolvedTitle}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top text-sm text-slate-700">
                    <p>{scheduledAtLabel(row)}</p>
                    {row.schedulingMode === 'awaiting_app_managed_publish' && (
                      <p className="mt-1 text-xs text-slate-600">
                        {row.targetDisplayName ?? 'This target'} doesn&apos;t support native
                        scheduling — ReelBridge will trigger this post itself at the scheduled
                        time rather than the platform holding it.
                      </p>
                    )}
                    {row.schedulingMode === 'native_scheduled' && row.scheduledAt && (
                      <p className="mt-1 text-xs text-slate-500">
                        The platform will hold and publish this natively.
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top text-sm">
                    {row.warnings.length === 0 ? (
                      <span className="text-xs text-slate-400">None</span>
                    ) : (
                      <ul className="space-y-1.5">
                        {row.warnings.map((warning, index) => {
                          const blocking = warning.severity === 'blocking';
                          return (
                            <li
                              key={`${warning.code}-${index}`}
                              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                                blocking
                                  ? 'border border-red-200 bg-red-50 text-red-700'
                                  : 'border border-amber-200 bg-amber-50 text-amber-700'
                              }`}
                            >
                              <span className="font-semibold">
                                {blocking ? 'Blocking' : 'Warning'}:
                              </span>{' '}
                              {warning.message}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasNonBlockingWarnings && !hasBlocking && (
        <label className="mt-6 flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          I&apos;ve reviewed the warnings above and want to proceed.
        </label>
      )}

      {hasBlocking && (
        <p role="alert" className="mt-6 text-sm font-medium text-red-600">
          Resolve the blocking issues above before this batch can be scheduled.
        </p>
      )}

      {publishError && (
        <p role="alert" id="publish-error" className="mt-4 text-sm font-medium text-red-600">
          {publishError}
        </p>
      )}

      {publishResult && (
        <p role="status" className="mt-4 text-sm font-medium text-emerald-600">
          Scheduled {publishResult.queuedCount} post
          {publishResult.queuedCount === 1 ? '' : 's'} for publishing.
        </p>
      )}

      <button
        type="button"
        onClick={() => void handlePublish()}
        disabled={publishDisabled}
        aria-describedby={publishError ? 'publish-error' : undefined}
        className="mt-6 inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {publishing ? 'Scheduling…' : 'Schedule batch'}
      </button>
    </div>
  );
}

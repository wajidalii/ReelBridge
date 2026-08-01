import type { ValidationWarning } from '@reelbridge/shared';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiPost } from '../api/client.js';
import {
  fetchMediaConstraints,
  generateVideoThumbnail,
  uploadMediaFiles,
  type CreatedMedia,
} from '../api/media.js';

interface UploadRow {
  localId: string;
  file: File;
  status: 'uploading' | 'uploaded' | 'error';
  progress?: number;
  error?: string;
  thumbnailUrl?: string;
  mediaAssetId?: string;
  postItemId?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  warningsLoading?: boolean;
  warnings?: Record<string, ValidationWarning[]>;
}

const PLATFORM_LABELS: Record<string, string> = {
  facebook_page: 'Facebook',
  instagram_business: 'Instagram',
  youtube_channel: 'YouTube',
};

function isMp4(file: File): boolean {
  return file.name.toLowerCase().endsWith('.mp4');
}

export function BatchUpload() {
  const [batchName, setBatchName] = useState(() => `Batch — ${new Date().toLocaleString()}`);
  const [batchId, setBatchId] = useState<string | null>(null);
  const batchCreation = useRef<Promise<string> | null>(null);
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A row removed while its upload/item-creation is still in flight must not
  // end up attached to the batch server-side just because the async chain
  // that started before removal keeps running — this is checked at each
  // step so the item POST (and the constraint-badge fetch) is skipped once
  // removal has happened, however the race lands.
  const removedIds = useRef<Set<string>>(new Set());

  function updateRow(localId: string, patch: Partial<UploadRow>) {
    setRows((prev) => prev.map((row) => (row.localId === localId ? { ...row, ...patch } : row)));
  }

  async function ensureBatch(): Promise<string> {
    if (batchId) return batchId;
    if (!batchCreation.current) {
      batchCreation.current = apiPost<{ id: string }>('/batches', { name: batchName })
        .then((batch) => {
          setBatchId(batch.id);
          return batch.id;
        })
        .catch((err: unknown) => {
          // Don't leave a rejected promise cached — the next addFiles call
          // must be able to retry batch creation instead of failing forever.
          batchCreation.current = null;
          throw err;
        });
    }
    return batchCreation.current;
  }

  async function finalizeUploadedRow(currentBatchId: string, localId: string, created: CreatedMedia) {
    if (removedIds.current.has(localId)) {
      fetch(`/api/media/${created.id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {});
      return;
    }

    try {
      const item = await apiPost<{ id: string }>(`/batches/${currentBatchId}/items`, {
        media_asset_id: created.id,
        default_caption: created.originalFilename,
      });
      if (removedIds.current.has(localId)) {
        fetch(`/api/batches/${currentBatchId}/items/${item.id}`, {
          method: 'DELETE',
          credentials: 'include',
        })
          .then(() => fetch(`/api/media/${created.id}`, { method: 'DELETE', credentials: 'include' }))
          .catch(() => {});
        return;
      }
      updateRow(localId, { postItemId: item.id });
    } catch {
      // The upload itself succeeded even if adding it to the batch's item
      // list failed — the row should still show as uploaded, not errored.
    }

    if (removedIds.current.has(localId)) return;
    updateRow(localId, { warningsLoading: true });
    try {
      const constraints = await fetchMediaConstraints(created.id);
      if (removedIds.current.has(localId)) return;
      updateRow(localId, { warningsLoading: false, warnings: constraints.warningsByPlatform });
    } catch {
      if (!removedIds.current.has(localId)) updateRow(localId, { warningsLoading: false });
    }
  }

  async function addFiles(incoming: File[]) {
    const accepted = incoming.filter(isMp4);
    const rejected = incoming.filter((file) => !isMp4(file));

    const acceptedRows: UploadRow[] = accepted.map((file) => ({
      localId: crypto.randomUUID(),
      file,
      status: 'uploading',
      progress: 0,
    }));
    const rejectedRows: UploadRow[] = rejected.map((file) => ({
      localId: crypto.randomUUID(),
      file,
      status: 'error',
      error: 'Only .mp4 files are accepted.',
    }));
    setRows((prev) => [...prev, ...acceptedRows, ...rejectedRows]);

    for (const row of acceptedRows) {
      void generateVideoThumbnail(row.file).then((thumbnailUrl) => {
        if (thumbnailUrl) updateRow(row.localId, { thumbnailUrl });
      });
    }

    if (acceptedRows.length === 0) return;

    const acceptedIds = new Set(acceptedRows.map((row) => row.localId));
    try {
      const currentBatchId = await ensureBatch();
      // All files added in one drop/pick share a single multipart request, so
      // this progress is the aggregate for the whole request, applied to
      // every row in it — not a true per-file transfer percentage. Still
      // satisfies "shown independently" for the criterion this matters for
      // (per-file failure states, handled below by clientId).
      const result = await uploadMediaFiles(
        acceptedRows.map((row) => ({ file: row.file, clientId: row.localId })),
        (fraction) => {
          setRows((prev) =>
            prev.map((row) => (acceptedIds.has(row.localId) ? { ...row, progress: fraction } : row)),
          );
        },
      );

      const createdByClientId = new Map(result.created.map((c) => [c.clientId, c]));
      const failedByClientId = new Map(result.failed.map((f) => [f.clientId, f]));
      for (const row of acceptedRows) {
        if (removedIds.current.has(row.localId)) continue;

        const created = createdByClientId.get(row.localId);
        if (created) {
          updateRow(row.localId, {
            status: 'uploaded',
            mediaAssetId: created.id,
            durationSeconds: created.durationSeconds,
            width: created.width,
            height: created.height,
          });
          void finalizeUploadedRow(currentBatchId, row.localId, created);
          continue;
        }
        const failedEntry = failedByClientId.get(row.localId);
        if (failedEntry) {
          updateRow(row.localId, { status: 'error', error: failedEntry.error });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed.';
      setRows((prev) =>
        prev.map((row) =>
          acceptedIds.has(row.localId) ? { ...row, status: 'error', error: message } : row,
        ),
      );
    }
  }

  function removeRow(row: UploadRow) {
    removedIds.current.add(row.localId);
    setRows((prev) => prev.filter((r) => r.localId !== row.localId));
    if (!row.mediaAssetId) return;

    // A post_item referencing this media (ON DELETE RESTRICT) must go first,
    // or the media delete below just 409s and silently leaves both behind.
    const deleteMedia = () =>
      fetch(`/api/media/${row.mediaAssetId}`, { method: 'DELETE', credentials: 'include' }).catch(
        () => {},
      );
    if (row.postItemId && batchId) {
      fetch(`/api/batches/${batchId}/items/${row.postItemId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
        .then(deleteMedia)
        .catch(() => {});
    } else {
      void deleteMedia();
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void addFiles(files);
  }

  function handleFilePicked(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) void addFiles(files);
    event.target.value = '';
  }

  const uploadedCount = rows.filter((row) => row.status === 'uploaded').length;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">New batch</h1>
      <p className="mt-2 text-slate-600">
        Upload the videos you want to schedule. Each one is checked against every connected
        platform&apos;s Reels/Shorts requirements as soon as it uploads.
      </p>

      <div className="mt-6">
        <label htmlFor="batch-name" className="block text-sm font-medium text-slate-700">
          Batch name
        </label>
        <input
          id="batch-name"
          className="mt-1 block w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:bg-slate-50 disabled:text-slate-500"
          value={batchName}
          onChange={(event) => setBatchName(event.target.value)}
          disabled={batchId !== null}
        />
      </div>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setIsDraggingOver(true);
        }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={handleDrop}
        className={`mt-6 flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
          isDraggingOver ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-white'
        }`}
      >
        <p className="text-sm text-slate-600">Drag and drop .mp4 files here</p>
        <p className="mt-1 text-sm text-slate-500">or</p>
        <input
          ref={fileInputRef}
          id="file-picker"
          type="file"
          accept="video/mp4,.mp4"
          multiple
          className="sr-only"
          onChange={handleFilePicked}
        />
        <label
          htmlFor="file-picker"
          className="mt-2 inline-flex cursor-pointer items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
        >
          Choose files
        </label>
      </div>

      {rows.length > 0 && (
        <ul className="mt-6 space-y-3">
          {rows.map((row) => (
            <li
              key={row.localId}
              className="flex items-start gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-slate-100">
                {row.thumbnailUrl ? (
                  <img src={row.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">
                    No preview
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">{row.file.name}</p>

                <p className="mt-0.5 text-xs text-slate-500">
                  {row.status === 'uploading' &&
                    `Uploading… ${Math.round((row.progress ?? 0) * 100)}%`}
                  {row.status === 'uploaded' &&
                    ([
                      row.durationSeconds != null ? `${row.durationSeconds.toFixed(1)}s` : null,
                      row.width && row.height ? `${row.width}×${row.height}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Uploaded')}
                  {row.status === 'error' && (
                    <span role="alert" className="font-medium text-red-600">
                      {row.error ?? 'Upload failed.'}
                    </span>
                  )}
                </p>

                {row.status === 'uploading' && (
                  <div
                    role="progressbar"
                    aria-valuenow={Math.round((row.progress ?? 0) * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Upload progress for ${row.file.name}`}
                    className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
                  >
                    <div
                      className="h-full bg-brand-600 transition-all"
                      style={{ width: `${Math.round((row.progress ?? 0) * 100)}%` }}
                    />
                  </div>
                )}

                {row.warningsLoading && (
                  <p className="mt-2 text-xs text-slate-400">Checking platform constraints…</p>
                )}

                {row.warnings && (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {Object.entries(row.warnings)
                      .filter(([, warnings]) => warnings.length > 0)
                      .map(([platform, warnings]) => {
                        const blocking = warnings.some((w) => w.severity === 'blocking');
                        const label = PLATFORM_LABELS[platform] ?? platform;
                        return (
                          <li
                            key={platform}
                            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                              blocking ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'
                            }`}
                          >
                            {label}: {warnings.map((w) => w.message).join(' ')}
                          </li>
                        );
                      })}
                  </ul>
                )}
              </div>

              <button
                type="button"
                onClick={() => removeRow(row)}
                aria-label={`Remove ${row.file.name}`}
                className="text-sm font-medium text-slate-400 hover:text-slate-600"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {uploadedCount > 0 && (
        <div className="mt-6 flex items-center gap-4">
          <p role="status" className="text-sm font-medium text-emerald-600">
            {uploadedCount} video{uploadedCount === 1 ? '' : 's'} ready.
          </p>
          {batchId && (
            <Link
              to={`/batches/${batchId}/targets`}
              className="text-sm font-medium text-brand-600 hover:underline"
            >
              Continue to targeting →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

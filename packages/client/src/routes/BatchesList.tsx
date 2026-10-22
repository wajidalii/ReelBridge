import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useBatches, useDeleteBatch } from '../api/batches.js';
import { InlineConfirm } from '../components/InlineConfirm.js';
import {
  cardClasses,
  errorMessage,
  primaryButtonClasses,
  secondaryButtonClasses,
} from '../components/ui.js';

const PAGE_SIZE = 20;

const BATCH_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  scheduling: 'Scheduling',
  active: 'Publishing',
  completed: 'Completed',
};

export function BatchesList() {
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isError, error } = useBatches(PAGE_SIZE, offset);
  const deleteBatch = useDeleteBatch();
  const total = data?.total ?? 0;

  return (
    <div className="max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Batches</h1>
          <p className="mt-2 text-slate-600">Every upload batch, newest first.</p>
        </div>
        <Link to="/upload" className={primaryButtonClasses}>
          New batch
        </Link>
      </div>

      {isLoading && (
        <p role="status" aria-live="polite" className="mt-6 text-sm text-slate-500">
          Loading batches…
        </p>
      )}
      {isError && (
        <p role="alert" className="mt-6 text-sm font-medium text-red-600">
          {errorMessage(error, 'Could not load batches.')}
        </p>
      )}
      {deleteBatch.isError && (
        <p role="alert" className="mt-6 text-sm font-medium text-red-600">
          {errorMessage(deleteBatch.error, 'Could not delete the batch.')}
        </p>
      )}

      {data && data.batches.length === 0 && (
        <div className={`mt-6 ${cardClasses}`}>
          <p className="text-sm text-slate-600">
            No batches yet.{' '}
            <Link to="/upload" className="font-medium text-brand-600 hover:underline">
              Upload some videos
            </Link>{' '}
            to create one.
          </p>
        </div>
      )}

      {data && data.batches.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Batch
                </th>
                <th scope="col" className="px-4 py-3">
                  Status
                </th>
                <th scope="col" className="px-4 py-3">
                  Videos
                </th>
                <th scope="col" className="px-4 py-3">
                  Posts
                </th>
                <th scope="col" className="px-4 py-3">
                  Created
                </th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.batches.map((batch) => {
                const isDraft = batch.status === 'draft';
                const href = isDraft ? `/batches/${batch.id}/targets` : '/posts';
                return (
                  <tr key={batch.id}>
                    <td className="px-4 py-3">
                      <Link to={href} className="font-medium text-brand-600 hover:underline">
                        {batch.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {BATCH_STATUS_LABELS[batch.status] ?? batch.status}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">{batch.itemCount}</td>
                    <td className="px-4 py-3 text-slate-700">
                      {batch.targetCount} total
                      {batch.publishedCount > 0 && ` · ${batch.publishedCount} published`}
                      {batch.failedCount > 0 && (
                        <span className="text-red-700"> · {batch.failedCount} failed</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {new Date(batch.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isDraft ? (
                        <InlineConfirm
                          label="Delete"
                          confirmLabel="Delete batch"
                          description="This removes the batch and its video assignments."
                          pending={deleteBatch.isPending && deleteBatch.variables === batch.id}
                          onConfirm={() => deleteBatch.mutate(batch.id)}
                        />
                      ) : (
                        <Link
                          to="/posts"
                          className="text-sm font-medium text-slate-600 hover:underline"
                        >
                          View posts
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm">
          <button
            type="button"
            className={secondaryButtonClasses}
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </button>
          <span className="text-slate-600">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <button
            type="button"
            className={secondaryButtonClasses}
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}

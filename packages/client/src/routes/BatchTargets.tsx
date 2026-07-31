import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  assignTargets,
  autoDistribute,
  useBatch,
  type AssignTargetInput,
  type BatchItem,
} from '../api/batches.js';
import { useTargets } from '../api/targets.js';

type SchedulingMode = 'now' | 'explicit' | 'auto';

interface ItemUiState {
  selectedTargetIds: Set<string>;
  customizePerPlatform: boolean;
  sharedCaption: string;
  perTargetCaption: Record<string, string>;
  perTargetTitle: Record<string, string>;
  perTargetScheduledAt: Record<string, string>;
  /** Keyed by publish_target_id — lets an error render next to the specific
   *  target row that caused it, not just a single blob for the whole video. */
  rejectedByTarget: Record<string, string>;
  submitting: boolean;
  submitError: string | null;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 100) ?? '';
}

function makeItemUiState(item: BatchItem): ItemUiState {
  return {
    selectedTargetIds: new Set(),
    customizePerPlatform: false,
    sharedCaption: item.defaultCaption,
    perTargetCaption: {},
    perTargetTitle: {},
    perTargetScheduledAt: {},
    rejectedByTarget: {},
    submitting: false,
    submitError: null,
  };
}

const inputClasses =
  'block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm ' +
  'focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30';

export function BatchTargets() {
  const { batchId } = useParams<{ batchId: string }>();
  const { data: batch, isLoading: batchLoading } = useBatch(batchId);
  const { data: targets, isLoading: targetsLoading } = useTargets();
  const queryClient = useQueryClient();

  const [itemUi, setItemUi] = useState<Record<string, ItemUiState>>({});
  const [schedulingMode, setSchedulingMode] = useState<SchedulingMode>('now');
  const [dailySlotTimesInput, setDailySlotTimesInput] = useState('09:00');
  const [autoDistributing, setAutoDistributing] = useState(false);
  const [autoDistributeError, setAutoDistributeError] = useState<string | null>(null);

  function getItemUi(item: BatchItem): ItemUiState {
    return itemUi[item.id] ?? makeItemUiState(item);
  }

  function updateItemUi(itemId: string, patch: Partial<ItemUiState>) {
    setItemUi((prev) => {
      const current = prev[itemId] ?? makeItemUiState(batch!.items.find((i) => i.id === itemId)!);
      return { ...prev, [itemId]: { ...current, ...patch } };
    });
  }

  function toggleTarget(item: BatchItem, targetId: string) {
    const ui = getItemUi(item);
    const next = new Set(ui.selectedTargetIds);
    let perTargetScheduledAt = ui.perTargetScheduledAt;
    if (next.has(targetId)) {
      next.delete(targetId);
      // Drop any previously generated time so re-checking this target later
      // (possibly after the window has shifted) doesn't silently resubmit a
      // stale auto-distribute result instead of a freshly computed one.
      if (targetId in perTargetScheduledAt) {
        perTargetScheduledAt = { ...perTargetScheduledAt };
        delete perTargetScheduledAt[targetId];
      }
    } else {
      next.add(targetId);
    }
    updateItemUi(item.id, { selectedTargetIds: next, perTargetScheduledAt });
  }

  function captionFor(ui: ItemUiState, targetId: string): string {
    if (ui.customizePerPlatform) {
      return ui.perTargetCaption[targetId] ?? ui.sharedCaption;
    }
    return ui.sharedCaption;
  }

  function titleFor(item: BatchItem, ui: ItemUiState, targetId: string): string {
    const caption = captionFor(ui, targetId);
    return ui.perTargetTitle[targetId] ?? item.defaultTitle ?? firstLine(caption);
  }

  async function saveItem(item: BatchItem) {
    if (!batchId) return;
    const ui = getItemUi(item);
    const existingTargetIds = new Set(item.targets.map((t) => t.publishTargetId));
    const targetIdsToSubmit = [...ui.selectedTargetIds].filter(
      (id) => !existingTargetIds.has(id),
    );
    if (targetIdsToSubmit.length === 0) return;

    const targetsById = new Map((targets ?? []).map((t) => [t.id, t]));
    const clientRejected: Record<string, string> = {};
    const payload: AssignTargetInput[] = [];

    for (const targetId of targetIdsToSubmit) {
      const target = targetsById.get(targetId);
      const caption = captionFor(ui, targetId);
      const input: AssignTargetInput = { publish_target_id: targetId, caption_override: caption };
      if (target?.platform === 'youtube_channel') {
        input.title_override = titleFor(item, ui, targetId);
      }

      if (schedulingMode !== 'now') {
        const scheduledAtLocal = ui.perTargetScheduledAt[targetId];
        if (scheduledAtLocal) {
          const scheduledDate = new Date(scheduledAtLocal);
          const capabilities = target?.capabilities;
          if (capabilities) {
            const leadMinutes = (scheduledDate.getTime() - Date.now()) / 60_000;
            if (
              capabilities.minScheduleLeadMinutes != null &&
              leadMinutes < capabilities.minScheduleLeadMinutes
            ) {
              clientRejected[targetId] =
                `Needs at least ${capabilities.minScheduleLeadMinutes} minutes of lead time for ${target?.displayName}.`;
              continue;
            }
            if (capabilities.maxScheduleLeadDays != null) {
              const leadDays = leadMinutes / (60 * 24);
              if (leadDays > capabilities.maxScheduleLeadDays) {
                clientRejected[targetId] =
                  `Can't be scheduled more than ${capabilities.maxScheduleLeadDays} days out for ${target?.displayName}.`;
                continue;
              }
            }
          }
          input.scheduled_at = scheduledDate.toISOString();
        }
      }
      payload.push(input);
    }

    updateItemUi(item.id, {
      submitting: true,
      submitError: null,
      rejectedByTarget: clientRejected,
    });

    if (payload.length === 0) {
      updateItemUi(item.id, { submitting: false });
      return;
    }

    try {
      const result = await assignTargets(batchId, item.id, payload);
      if (result.rejected.length > 0) {
        const rejectedByTarget = { ...clientRejected };
        for (const rejection of result.rejected) {
          rejectedByTarget[rejection.publish_target_id] = rejection.error;
        }
        updateItemUi(item.id, { rejectedByTarget });
      }
      await queryClient.invalidateQueries({ queryKey: ['batch', batchId] });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save this video.';
      const rejectedByTarget = { ...clientRejected };
      for (const targetId of targetIdsToSubmit) {
        if (!(targetId in rejectedByTarget)) rejectedByTarget[targetId] = message;
      }
      updateItemUi(item.id, { submitError: message, rejectedByTarget });
    } finally {
      updateItemUi(item.id, { submitting: false });
    }
  }

  async function generateAutoSchedule() {
    if (!batchId || !batch) return;
    const dailySlotTimes = dailySlotTimesInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (dailySlotTimes.length === 0) {
      setAutoDistributeError('Enter at least one daily time (e.g. 09:00).');
      return;
    }

    setAutoDistributing(true);
    setAutoDistributeError(null);
    try {
      const itemIdsByTarget = new Map<string, string[]>();
      for (const item of batch.items) {
        const ui = getItemUi(item);
        const existingTargetIds = new Set(item.targets.map((t) => t.publishTargetId));
        for (const targetId of ui.selectedTargetIds) {
          if (existingTargetIds.has(targetId)) continue;
          const list = itemIdsByTarget.get(targetId) ?? [];
          list.push(item.id);
          itemIdsByTarget.set(targetId, list);
        }
      }

      // Collected first, applied in one functional state update below —
      // calling updateItemUi once per assignment inside this loop would read
      // a stale `ui` for every target after the first on a given item (since
      // the closure never sees the previous await's result), silently
      // dropping all but the last-generated time when one video has more
      // than one newly-selected target.
      const allAssignments: Array<{ itemId: string; targetId: string; scheduledAt: string }> = [];
      let totalLeftover = 0;
      for (const [targetId, itemIds] of itemIdsByTarget) {
        const result = await autoDistribute(batchId, targetId, itemIds, dailySlotTimes);
        totalLeftover += result.leftoverCount;
        for (const assignment of result.assignments) {
          allAssignments.push({
            itemId: assignment.item_id,
            targetId,
            scheduledAt: assignment.scheduled_at,
          });
        }
      }

      setItemUi((prev) => {
        const next = { ...prev };
        for (const { itemId, targetId, scheduledAt } of allAssignments) {
          const current = next[itemId] ?? makeItemUiState(batch.items.find((i) => i.id === itemId)!);
          next[itemId] = {
            ...current,
            perTargetScheduledAt: { ...current.perTargetScheduledAt, [targetId]: scheduledAt },
          };
        }
        return next;
      });

      if (totalLeftover > 0) {
        setAutoDistributeError(
          `${totalLeftover} item-target pair${totalLeftover === 1 ? '' : 's'} couldn't fit in the ` +
            'current schedule window — add more daily times, extend the window, or select fewer items.',
        );
      }
    } catch (err) {
      setAutoDistributeError(err instanceof Error ? err.message : 'Failed to generate a schedule.');
    } finally {
      setAutoDistributing(false);
    }
  }

  if (batchLoading || targetsLoading) {
    return <p className="text-slate-600">Loading…</p>;
  }
  if (!batch) {
    return <p className="text-red-600">Batch not found.</p>;
  }

  const availableTargets = targets ?? [];

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">
        Assign targets — {batch.name}
      </h1>
      <p className="mt-2 text-slate-600">
        Choose where each video goes, customize captions if needed, and decide when it publishes.
      </p>

      <fieldset className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">Scheduling</legend>
        <div className="flex flex-wrap gap-4">
          {(
            [
              { value: 'now', label: 'Publish now' },
              { value: 'explicit', label: 'Pick date & time per video' },
              { value: 'auto', label: 'Auto-distribute' },
            ] as const
          ).map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="radio"
                name="scheduling-mode"
                checked={schedulingMode === option.value}
                onChange={() => setSchedulingMode(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>

        {schedulingMode === 'auto' && (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="daily-slot-times" className="block text-sm font-medium text-slate-700">
                Daily times (24h, comma-separated)
              </label>
              <input
                id="daily-slot-times"
                className={`mt-1 ${inputClasses}`}
                value={dailySlotTimesInput}
                onChange={(event) => setDailySlotTimesInput(event.target.value)}
                placeholder="09:00, 17:00"
              />
            </div>
            <button
              type="button"
              onClick={() => void generateAutoSchedule()}
              disabled={autoDistributing}
              className="inline-flex items-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {autoDistributing ? 'Generating…' : 'Generate schedule'}
            </button>
          </div>
        )}
        {autoDistributeError && (
          <p role="alert" className="mt-2 text-sm font-medium text-red-600">
            {autoDistributeError}
          </p>
        )}
      </fieldset>

      <ul className="mt-6 space-y-6">
        {batch.items.map((item) => {
          const ui = getItemUi(item);
          const existingTargetIds = new Set(item.targets.map((t) => t.publishTargetId));
          const selectedNewTargetIds = [...ui.selectedTargetIds].filter(
            (id) => !existingTargetIds.has(id),
          );

          return (
            <li key={item.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-sm font-medium text-slate-900">
                {item.media?.originalFilename ?? 'Unknown file'}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {[
                  item.media?.durationSeconds != null
                    ? `${item.media.durationSeconds.toFixed(1)}s`
                    : null,
                  item.media?.width && item.media.height
                    ? `${item.media.width}×${item.media.height}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>

              <fieldset className="mt-4">
                <legend className="text-sm font-semibold text-slate-900">Targets</legend>
                <div className="mt-2 flex flex-wrap gap-4">
                  {availableTargets.map((target) => {
                    const alreadyAssigned = existingTargetIds.has(target.id);
                    const isSelected = ui.selectedTargetIds.has(target.id);
                    const rowId = `${item.id}-${target.id}`;
                    return (
                      <label
                        key={target.id}
                        className="flex items-center gap-2 text-sm text-slate-700"
                      >
                        <input
                          type="checkbox"
                          checked={isSelected || alreadyAssigned}
                          disabled={alreadyAssigned}
                          aria-describedby={
                            isSelected && !target.capabilities.nativeScheduling
                              ? `${rowId}-scheduling-note`
                              : undefined
                          }
                          onChange={() => toggleTarget(item, target.id)}
                        />
                        {target.displayName}
                        {alreadyAssigned && (
                          <span className="text-xs text-slate-400">(already assigned)</span>
                        )}
                      </label>
                    );
                  })}
                  {availableTargets.length === 0 && (
                    <p className="text-sm text-slate-500">
                      No connected targets yet — connect a platform first.
                    </p>
                  )}
                </div>
              </fieldset>

              {selectedNewTargetIds.length > 0 && (
                <div className="mt-4 space-y-4 border-t border-slate-100 pt-4">
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={ui.customizePerPlatform}
                      onChange={(event) =>
                        updateItemUi(item.id, { customizePerPlatform: event.target.checked })
                      }
                    />
                    Customize captions per platform
                  </label>

                  {!ui.customizePerPlatform && (
                    <div>
                      <label
                        htmlFor={`${item.id}-shared-caption`}
                        className="block text-sm font-medium text-slate-700"
                      >
                        Caption (all selected targets)
                      </label>
                      <textarea
                        id={`${item.id}-shared-caption`}
                        className={`mt-1 ${inputClasses}`}
                        rows={2}
                        value={ui.sharedCaption}
                        onChange={(event) =>
                          updateItemUi(item.id, { sharedCaption: event.target.value })
                        }
                      />
                    </div>
                  )}

                  {selectedNewTargetIds.map((targetId) => {
                    const target = availableTargets.find((t) => t.id === targetId);
                    if (!target) return null;
                    const rowId = `${item.id}-${targetId}`;
                    const caption = captionFor(ui, targetId);
                    const rowError = ui.rejectedByTarget[targetId];
                    const describedByIds = [
                      !target.capabilities.nativeScheduling ? `${rowId}-scheduling-note` : null,
                      rowError ? `${rowId}-error` : null,
                    ]
                      .filter(Boolean)
                      .join(' ') || undefined;

                    return (
                      <div key={targetId} className="rounded-lg bg-slate-50 p-3">
                        <p className="text-sm font-semibold text-slate-800">{target.displayName}</p>

                        {ui.customizePerPlatform && (
                          <div className="mt-2">
                            <label
                              htmlFor={`${rowId}-caption`}
                              className="block text-xs font-medium text-slate-700"
                            >
                              Caption
                            </label>
                            <textarea
                              id={`${rowId}-caption`}
                              className={`mt-1 ${inputClasses}`}
                              rows={2}
                              aria-describedby={describedByIds}
                              value={caption}
                              onChange={(event) =>
                                updateItemUi(item.id, {
                                  perTargetCaption: {
                                    ...ui.perTargetCaption,
                                    [targetId]: event.target.value,
                                  },
                                })
                              }
                            />
                          </div>
                        )}

                        {target.platform === 'youtube_channel' && (
                          <div className="mt-2">
                            <label
                              htmlFor={`${rowId}-title`}
                              className="block text-xs font-medium text-slate-700"
                            >
                              Title
                            </label>
                            <input
                              id={`${rowId}-title`}
                              className={`mt-1 ${inputClasses}`}
                              aria-describedby={describedByIds}
                              value={titleFor(item, ui, targetId)}
                              onChange={(event) =>
                                updateItemUi(item.id, {
                                  perTargetTitle: {
                                    ...ui.perTargetTitle,
                                    [targetId]: event.target.value,
                                  },
                                })
                              }
                            />
                          </div>
                        )}

                        {!target.capabilities.nativeScheduling && (
                          <p
                            id={`${rowId}-scheduling-note`}
                            className="mt-2 text-xs text-slate-600"
                          >
                            {target.displayName} doesn&apos;t support native scheduling — ReelBridge
                            will trigger this post itself at the scheduled time rather than the
                            platform holding it.
                          </p>
                        )}

                        {schedulingMode === 'explicit' && (
                          <div className="mt-2">
                            <label
                              htmlFor={`${rowId}-datetime`}
                              className="block text-xs font-medium text-slate-700"
                            >
                              Publish at
                            </label>
                            <input
                              id={`${rowId}-datetime`}
                              type="datetime-local"
                              className={`mt-1 ${inputClasses}`}
                              aria-describedby={describedByIds}
                              value={ui.perTargetScheduledAt[targetId] ?? ''}
                              onChange={(event) =>
                                updateItemUi(item.id, {
                                  perTargetScheduledAt: {
                                    ...ui.perTargetScheduledAt,
                                    [targetId]: event.target.value,
                                  },
                                })
                              }
                            />
                            <p className="mt-1 text-xs text-slate-500">
                              Entered in your browser&apos;s local time. {target.displayName}{' '}
                              publishes in{' '}
                              <span className="font-medium">{target.timezone ?? 'UTC'}</span> —
                              double-check the converted time if these differ.
                            </p>
                          </div>
                        )}

                        {rowError && (
                          <p
                            role="alert"
                            id={`${rowId}-error`}
                            className="mt-2 text-xs font-medium text-red-600"
                          >
                            {rowError}
                          </p>
                        )}

                        {schedulingMode === 'auto' && (
                          <p className="mt-2 text-xs text-slate-600">
                            {ui.perTargetScheduledAt[targetId]
                              ? `Scheduled for ${new Date(
                                  ui.perTargetScheduledAt[targetId] as string,
                                ).toLocaleString()}`
                              : 'Not yet scheduled — click "Generate schedule" above.'}
                          </p>
                        )}
                      </div>
                    );
                  })}

                  {ui.submitError && (
                    <p
                      role="alert"
                      id={`${item.id}-error`}
                      className="text-sm font-medium text-red-600"
                    >
                      {ui.submitError}
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => void saveItem(item)}
                    disabled={ui.submitting}
                    aria-describedby={ui.submitError ? `${item.id}-error` : undefined}
                    className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {ui.submitting ? 'Saving…' : 'Save assignments'}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

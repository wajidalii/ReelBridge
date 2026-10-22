import { useEffect, useState } from 'react';
import {
  useSaveScheduleConfig,
  useScheduleConfig,
  useTriggerSchedule,
  type ScheduleCadence,
  type Target,
} from '../api/targets.js';
import {
  errorMessage,
  inputClasses,
  primaryButtonClasses,
  secondaryButtonClasses,
  selectClasses,
} from './ui.js';

const CADENCE_LABELS: Record<ScheduleCadence, string> = {
  hourly: 'Every hour',
  every_6_hours: 'Every 6 hours',
  daily: 'Daily',
  weekly: 'Weekly',
};

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Madrid',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const RUN_STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

export function ScheduleConfigPanel({ target }: { target: Target }) {
  const { data, isLoading, isError, error } = useScheduleConfig(target.id);
  const save = useSaveScheduleConfig(target.id);
  const trigger = useTriggerSchedule(target.id);

  const [slots, setSlots] = useState<string[]>(['09:00']);
  const [timezone, setTimezone] = useState(browserTimezone);
  const [cadence, setCadence] = useState<ScheduleCadence>('daily');
  const [maxDays, setMaxDays] = useState(7);
  const [enabled, setEnabled] = useState(true);
  const [hydrated, setHydrated] = useState(false);

  const platformMax = data?.platformMaxScheduleDays ?? 28;

  useEffect(() => {
    if (!data || hydrated) return;
    if (data.config) {
      setSlots(data.config.dailySlots.length > 0 ? data.config.dailySlots : ['09:00']);
      setTimezone(data.config.timezone);
      setCadence(data.config.cadence);
      setMaxDays(data.config.maxScheduleDays);
      setEnabled(data.config.isEnabled);
    } else {
      setMaxDays(Math.min(7, data.platformMaxScheduleDays));
    }
    setHydrated(true);
  }, [data, hydrated]);

  const invalidSlots = slots.filter((slot) => !HHMM.test(slot));
  const prefix = `schedule-${target.id}`;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (invalidSlots.length > 0 || slots.length === 0) return;
    save.mutate({
      daily_slots: [...new Set(slots)].sort(),
      timezone,
      cadence,
      max_schedule_days: Math.min(maxDays, platformMax),
      is_enabled: enabled,
    });
  }

  if (isLoading) {
    return (
      <p role="status" aria-live="polite" className="text-sm text-slate-500">
        Loading schedule…
      </p>
    );
  }
  if (isError) {
    return (
      <p role="alert" className="text-sm font-medium text-red-600">
        {errorMessage(error, 'Could not load the schedule.')}
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <h4 className="text-sm font-semibold text-slate-900">Recurring schedule</h4>
      <p className="mt-1 text-xs text-slate-600">
        Automatically assigns times to any posts for this target that don&apos;t have one yet,
        filling the next {platformMax} days at the slots below. Posts that don&apos;t fit wait for
        the next run.
      </p>
      {target.platform === 'instagram_business' && (
        <p className="mt-1 text-xs text-amber-800">
          Instagram&apos;s window is capped at {platformMax} days because ReelBridge itself triggers
          these posts at their scheduled time rather than Instagram holding them.
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-4 space-y-4" noValidate>
        <fieldset>
          <legend className="text-sm font-medium text-slate-700">Daily slot times</legend>
          <ul className="mt-1 space-y-2">
            {slots.map((slot, index) => {
              const id = `${prefix}-slot-${index}`;
              const invalid = !HHMM.test(slot);
              return (
                <li key={index} className="flex items-center gap-2">
                  <label htmlFor={id} className="sr-only">
                    Slot {index + 1} (HH:mm)
                  </label>
                  <input
                    id={id}
                    type="time"
                    required
                    className={`${inputClasses} w-36`}
                    value={slot}
                    onChange={(event) =>
                      setSlots((prev) => prev.map((s, i) => (i === index ? event.target.value : s)))
                    }
                    aria-invalid={invalid || undefined}
                    aria-describedby={invalid ? `${id}-error` : undefined}
                  />
                  {invalid && (
                    <span id={`${id}-error`} className="text-xs font-medium text-red-600">
                      Use HH:mm
                    </span>
                  )}
                  <button
                    type="button"
                    className={secondaryButtonClasses}
                    disabled={slots.length === 1}
                    onClick={() => setSlots((prev) => prev.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className={`mt-2 ${secondaryButtonClasses}`}
            disabled={slots.length >= 24}
            onClick={() => setSlots((prev) => [...prev, '12:00'])}
          >
            Add slot
          </button>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${prefix}-tz`} className="block text-sm font-medium text-slate-700">
              Timezone (IANA)
            </label>
            <input
              id={`${prefix}-tz`}
              list={`${prefix}-tz-list`}
              className={`mt-1 ${inputClasses}`}
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              required
            />
            <datalist id={`${prefix}-tz-list`}>
              {COMMON_TIMEZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </div>
          <div>
            <label
              htmlFor={`${prefix}-cadence`}
              className="block text-sm font-medium text-slate-700"
            >
              Run topup
            </label>
            <select
              id={`${prefix}-cadence`}
              className={`mt-1 ${selectClasses} w-full`}
              value={cadence}
              onChange={(event) => setCadence(event.target.value as ScheduleCadence)}
            >
              {(Object.keys(CADENCE_LABELS) as ScheduleCadence[]).map((value) => (
                <option key={value} value={value}>
                  {CADENCE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${prefix}-days`} className="block text-sm font-medium text-slate-700">
              Schedule up to (days ahead)
            </label>
            <input
              id={`${prefix}-days`}
              type="number"
              min={1}
              max={platformMax}
              className={`mt-1 ${inputClasses}`}
              value={maxDays}
              onChange={(event) => setMaxDays(Number(event.target.value))}
              aria-describedby={`${prefix}-days-hint`}
            />
            <p id={`${prefix}-days-hint`} className="mt-1 text-xs text-slate-500">
              Maximum {platformMax} for this platform.
            </p>
          </div>
          <div className="flex items-end">
            <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              Enabled
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className={primaryButtonClasses}
            disabled={save.isPending || invalidSlots.length > 0}
          >
            {save.isPending ? 'Saving…' : 'Save schedule'}
          </button>
          <button
            type="button"
            className={secondaryButtonClasses}
            disabled={trigger.isPending || !data?.config}
            onClick={() => trigger.mutate()}
            title={data?.config ? undefined : 'Save a schedule first'}
          >
            {trigger.isPending ? 'Queuing…' : 'Run now'}
          </button>
          <span role="status" aria-live="polite" className="text-xs">
            {save.isSuccess && (
              <span className="font-medium text-emerald-700">Schedule saved.</span>
            )}
            {save.isError && (
              <span className="font-medium text-red-600">
                {errorMessage(save.error, 'Could not save.')}
              </span>
            )}
            {trigger.isSuccess && (
              <span className="font-medium text-emerald-700"> Run queued.</span>
            )}
            {trigger.isError && (
              <span className="font-medium text-red-600">
                {' '}
                {errorMessage(trigger.error, 'Could not queue a run.')}
              </span>
            )}
          </span>
        </div>
      </form>

      {data?.config && (
        <p className="mt-3 text-xs text-slate-500">
          Next run: {data.config.nextRunAt ? new Date(data.config.nextRunAt).toLocaleString() : '—'}{' '}
          · Last run:{' '}
          {data.config.lastRunAt ? new Date(data.config.lastRunAt).toLocaleString() : 'never'}
        </p>
      )}

      {data && data.recentRuns.length > 0 && (
        <div className="mt-4">
          <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Recent runs
          </h5>
          <ul className="mt-1 divide-y divide-slate-200 text-xs text-slate-700">
            {data.recentRuns.map((run) => (
              <li key={run.id} className="py-1.5">
                {new Date(run.startedAt).toLocaleString()} ·{' '}
                {RUN_STATUS_LABELS[run.status] ?? run.status} ·{' '}
                {run.triggeredBy === 'manual' ? 'manual' : 'automatic'} · considered{' '}
                {run.itemsConsidered}, scheduled {run.itemsScheduled}, left over {run.itemsLeftover}
                {run.errorMessage && <span className="text-red-700"> · {run.errorMessage}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

import { DateTime } from 'luxon';

export interface SlotGenerationParams {
  /** Number of pending items needing a slot. */
  pendingItemCount: number;
  /** "HH:mm" 24-hour times, in the target's timezone. Order doesn't matter — sorted internally. */
  dailySlotTimes: string[];
  /** IANA timezone, e.g. "America/New_York". */
  timezone: string;
  /** Minimum lead time (minutes) before the first eligible slot. null = no minimum. */
  minLeadMinutes: number | null;
  /** Maximum days out a slot may be scheduled. null = platform-unbounded (falls back to a sane default cap below). */
  maxLeadDays: number | null;
  /** Injectable "now" for deterministic tests. Defaults to the real current time. */
  now?: Date;
}

export interface SlotGenerationResult {
  /** One Date per item that got a slot, in chronological order. */
  scheduledTimes: Date[];
  /** pendingItemCount - scheduledTimes.length — items that didn't fit in the window this run. */
  leftoverCount: number;
}

/**
 * A platform reporting maxLeadDays: null (e.g. YouTube's native scheduling has
 * no documented upper bound) would otherwise generate slots indefinitely for a
 * large backlog — cap at a sane default instead of actually being unbounded.
 */
const DEFAULT_MAX_LEAD_DAYS_WHEN_UNBOUNDED = 90;

/**
 * Generalizes the Facebook-only CLI's slot-generation/cadence algorithm
 * (SAAS_PLAN.md) to any target: forward from now + minLeadMinutes, at fixed
 * daily times in the target's IANA timezone, stopping once a slot would
 * exceed now + maxLeadDays. Luxon (not naive Date math) keeps the local
 * wall-clock time-of-day correct across DST transitions — adding raw
 * milliseconds for "24 hours" would silently drift by an hour on a DST
 * boundary day.
 *
 * Purely generates slot times; sorting/prioritizing which pending items get
 * which slot is the caller's responsibility (that's a data-source concern —
 * e.g. "CSV-captioned-first" — not scheduling math).
 */
export function generateSchedulingSlots(params: SlotGenerationParams): SlotGenerationResult {
  const { pendingItemCount, dailySlotTimes, timezone, minLeadMinutes, maxLeadDays } = params;
  const now = params.now ?? new Date();

  if (pendingItemCount <= 0 || dailySlotTimes.length === 0) {
    return { scheduledTimes: [], leftoverCount: Math.max(pendingItemCount, 0) };
  }

  const earliestAllowedMillis = minLeadMinutes
    ? now.getTime() + minLeadMinutes * 60_000
    : now.getTime();
  const maxDays = maxLeadDays ?? DEFAULT_MAX_LEAD_DAYS_WHEN_UNBOUNDED;
  const latestAllowedMillis = now.getTime() + maxDays * 24 * 60 * 60_000;

  const sortedTimes = [...dailySlotTimes].sort();
  const scheduledTimes: Date[] = [];

  const startOfToday = DateTime.fromJSDate(now, { zone: timezone }).startOf('day');
  // Safety bound only — the inner return below is what actually stops iteration
  // once a slot exceeds the window (every later slot would too, since times
  // are sorted ascending and days only move forward).
  const maxIterationDays = maxDays + 2;

  for (let dayOffset = 0; dayOffset < maxIterationDays; dayOffset++) {
    if (scheduledTimes.length >= pendingItemCount) break;

    const day = startOfToday.plus({ days: dayOffset });

    for (const time of sortedTimes) {
      if (scheduledTimes.length >= pendingItemCount) break;

      const [hourStr, minuteStr] = time.split(':');
      const slot = day.set({
        hour: Number(hourStr),
        minute: Number(minuteStr),
        second: 0,
        millisecond: 0,
      });
      const slotMillis = slot.toMillis();

      if (slotMillis < earliestAllowedMillis) {
        continue;
      }
      if (slotMillis > latestAllowedMillis) {
        return { scheduledTimes, leftoverCount: pendingItemCount - scheduledTimes.length };
      }

      scheduledTimes.push(slot.toJSDate());
    }
  }

  return { scheduledTimes, leftoverCount: pendingItemCount - scheduledTimes.length };
}

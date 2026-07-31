import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { generateSchedulingSlots } from './slotGeneration.js';

const NEW_YORK = 'America/New_York';

describe('generateSchedulingSlots', () => {
  it('is deterministic given the same injected "now"', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const params = {
      pendingItemCount: 5,
      dailySlotTimes: ['09:00'],
      timezone: NEW_YORK,
      minLeadMinutes: 15,
      maxLeadDays: 29,
      now,
    };

    const first = generateSchedulingSlots(params);
    const second = generateSchedulingSlots(params);

    expect(first.scheduledTimes.map((d) => d.toISOString())).toEqual(
      second.scheduledTimes.map((d) => d.toISOString()),
    );
    expect(first.leftoverCount).toBe(second.leftoverCount);
  });

  it('computes leftover count correctly when the window is too small for every item', () => {
    // now = 2026-06-01 08:00 America/New_York; one slot/day, 3-day window -> at most 3 slots fit.
    const now = DateTime.fromISO('2026-06-01T08:00:00', { zone: NEW_YORK }).toJSDate();

    const result = generateSchedulingSlots({
      pendingItemCount: 10,
      dailySlotTimes: ['09:00'],
      timezone: NEW_YORK,
      minLeadMinutes: 15,
      maxLeadDays: 3,
      now,
    });

    expect(result.scheduledTimes).toHaveLength(3);
    expect(result.leftoverCount).toBe(7);
  });

  it('generates multiple daily slots per day in chronological order', () => {
    const now = DateTime.fromISO('2026-06-01T07:00:00', { zone: NEW_YORK }).toJSDate();

    const result = generateSchedulingSlots({
      pendingItemCount: 7,
      dailySlotTimes: ['20:00', '09:00', '15:00'], // deliberately unsorted input
      timezone: NEW_YORK,
      minLeadMinutes: 15,
      maxLeadDays: 29,
      now,
    });

    expect(result.scheduledTimes).toHaveLength(7);
    expect(result.leftoverCount).toBe(0);

    // First 6 slots: two full days of 09:00/15:00/20:00, then the 7th starts day 3's 09:00.
    const localTimes = result.scheduledTimes.map((d) =>
      DateTime.fromJSDate(d, { zone: NEW_YORK }).toFormat('yyyy-MM-dd HH:mm'),
    );
    expect(localTimes).toEqual([
      '2026-06-01 09:00',
      '2026-06-01 15:00',
      '2026-06-01 20:00',
      '2026-06-02 09:00',
      '2026-06-02 15:00',
      '2026-06-02 20:00',
      '2026-06-03 09:00',
    ]);

    // Strictly increasing.
    for (let i = 1; i < result.scheduledTimes.length; i++) {
      expect(result.scheduledTimes[i]!.getTime()).toBeGreaterThan(
        result.scheduledTimes[i - 1]!.getTime(),
      );
    }
  });

  it('keeps the local wall-clock time correct across a real US DST spring-forward boundary', () => {
    // 2024-03-10 is a real, historical US DST transition (2:00 AM -> 3:00 AM).
    const now = DateTime.fromISO('2024-03-08T08:00:00', { zone: NEW_YORK }).toJSDate();

    const result = generateSchedulingSlots({
      pendingItemCount: 5,
      dailySlotTimes: ['09:00'],
      timezone: NEW_YORK,
      minLeadMinutes: 15,
      maxLeadDays: 10,
      now,
    });

    expect(result.scheduledTimes).toHaveLength(5);

    // Every slot must land on 09:00 local time, even the ones after the DST boundary —
    // naive "add 24 hours" UTC math would drift this to 08:00 or 10:00 after the transition.
    for (const date of result.scheduledTimes) {
      const local = DateTime.fromJSDate(date, { zone: NEW_YORK });
      expect(local.toFormat('HH:mm')).toBe('09:00');
    }

    // The slots span March 8 (before) through March 12 (after) the March 10 transition.
    const localDates = result.scheduledTimes.map((d) =>
      DateTime.fromJSDate(d, { zone: NEW_YORK }).toFormat('yyyy-MM-dd'),
    );
    expect(localDates[0]).toBe('2024-03-08');
    expect(localDates.at(-1)).toBe('2024-03-12');

    // The gap between the pre- and post-transition slots is 23 hours in real elapsed
    // time (clocks sprang forward), not 24 — proof Luxon handled the DST shift instead
    // of doing naive millisecond arithmetic.
    const beforeTransition = result.scheduledTimes.find(
      (d) => DateTime.fromJSDate(d, { zone: NEW_YORK }).toFormat('yyyy-MM-dd') === '2024-03-09',
    )!;
    const afterTransition = result.scheduledTimes.find(
      (d) => DateTime.fromJSDate(d, { zone: NEW_YORK }).toFormat('yyyy-MM-dd') === '2024-03-10',
    )!;
    const gapHours = (afterTransition.getTime() - beforeTransition.getTime()) / (60 * 60 * 1000);
    expect(gapHours).toBe(23);
  });

  it('respects minLeadMinutes: null and maxLeadDays: null (unbounded platforms)', () => {
    const now = DateTime.fromISO('2026-06-01T08:00:00', { zone: NEW_YORK }).toJSDate();

    const result = generateSchedulingSlots({
      pendingItemCount: 2,
      dailySlotTimes: ['09:00'],
      timezone: NEW_YORK,
      minLeadMinutes: null,
      maxLeadDays: null,
      now,
    });

    expect(result.scheduledTimes).toHaveLength(2);
    expect(result.leftoverCount).toBe(0);
  });

  it('returns all-leftover for zero pending items or no daily slot times, without throwing', () => {
    const now = new Date('2026-06-01T12:00:00Z');

    expect(
      generateSchedulingSlots({
        pendingItemCount: 0,
        dailySlotTimes: ['09:00'],
        timezone: NEW_YORK,
        minLeadMinutes: 15,
        maxLeadDays: 29,
        now,
      }),
    ).toEqual({ scheduledTimes: [], leftoverCount: 0 });

    expect(
      generateSchedulingSlots({
        pendingItemCount: 5,
        dailySlotTimes: [],
        timezone: NEW_YORK,
        minLeadMinutes: 15,
        maxLeadDays: 29,
        now,
      }),
    ).toEqual({ scheduledTimes: [], leftoverCount: 5 });
  });
});

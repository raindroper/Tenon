import { localDayRange, zonedInstant } from '../shared/time.js';

/** Calendar-day boundaries in the owner's timezone, including 23/25-hour DST days. */
export function usageDayWindow(timestamp: number, timezone: string): { from: number; until: number } {
  const range = localDayRange(zonedInstant(timestamp, timezone).localDate, timezone);
  return { from: Date.parse(range.from), until: Date.parse(range.until) };
}

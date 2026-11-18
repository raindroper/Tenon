/** An exact instant projected into an explicit display timezone. UTC remains authoritative. */
export interface ZonedInstant {
  utc: string;
  timezone: string;
  localDate: string;
  localTime: string;
  weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  offsetSeconds: number;
}

export interface EvidenceTime {
  sent: ZonedInstant | null;
  received: ZonedInstant;
  occurred: ZonedInstant | null;
  occurredMeaning: 'message_sent' | 'collection' | 'recorded_event' | 'unknown';
  /** The original speaker's recorded timezone, not the owner's current display timezone. */
  referenceTimezone: string | null;
}

export interface TemporalContext {
  asOf: ZonedInstant;
  reference?: { at: ZonedInstant; originalTimezone: string | null };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

function formatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;
  const result = new Intl.DateTimeFormat('en-US', { timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'long', hourCycle: 'h23' });
  if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!);
  formatters.set(timezone, result);
  return result;
}

function instant(value: string | number | Date): Date {
  if (typeof value === 'string' && !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new RangeError('时间必须包含明确的 UTC 或 offset。');
  const date = new Date(value instanceof Date ? value.getTime() : value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('时间无效。');
  return date;
}

function parts(value: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(formatter(timezone).formatToParts(value).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function utcCalendarDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
  const date = new Date(0);
  // Date.UTC treats years 0..99 as 1900..1999; setting the complete year avoids that special case.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date;
}

export function zonedInstant(value: string | number | Date, timezone: string): ZonedInstant {
  const date = instant(value);
  const fields = parts(date, timezone);
  const year = fields.year.padStart(4, '0');
  const localEpoch = utcCalendarDate(Number(year), Number(fields.month), Number(fields.day),
    Number(fields.hour), Number(fields.minute), Number(fields.second)).getTime();
  const weekday = weekdays.indexOf(fields.weekday as typeof weekdays[number]) + 1;
  if (weekday < 1 || weekday > 7) throw new RangeError('无法确定当地星期。');
  return { utc: date.toISOString(), timezone, localDate: `${year}-${fields.month}-${fields.day}`,
    localTime: `${fields.hour}:${fields.minute}:${fields.second}`, weekday: weekday as ZonedInstant['weekday'],
    offsetSeconds: (localEpoch - Math.floor(date.getTime() / 1000) * 1000) / 1000 };
}

function knownTimezone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { formatter(value); return value; } catch { return null; }
}

/** Message timestamps never infer a sender's timezone or replace a missing send time. */
export function messageTime(message: { sentAt?: string | null; receivedAt: string; referenceTimezone?: string | null }, timezone: string): EvidenceTime {
  return { sent: message.sentAt ? zonedInstant(message.sentAt, timezone) : null,
    received: zonedInstant(message.receivedAt, timezone), occurred: null, occurredMeaning: 'unknown',
    referenceTimezone: knownTimezone(message.referenceTimezone) };
}

export function evidenceTime(event: { kind?: string; sourceId?: string; actor?: string; occurredAt: string; receivedAt: string;
  payload?: Record<string, unknown> }, timezone: string): EvidenceTime {
  const payload = event.payload ?? {};
  const ownerChat = event.actor === 'owner' && event.kind === 'owner.message' && event.sourceId === 'owner-chat';
  const wechat = event.kind === 'connector.change' && payload.provider === 'wechat-desktop';
  const sentAt = ownerChat ? event.occurredAt : wechat && typeof payload.sentAt === 'string' ? payload.sentAt : null;
  return { ...messageTime({ sentAt, receivedAt: event.receivedAt,
    referenceTimezone: ownerChat ? knownTimezone(payload.timezone) : null }, timezone),
    occurred: zonedInstant(event.occurredAt, timezone),
    occurredMeaning: ownerChat ? 'message_sent' : wechat ? 'collection' : 'recorded_event' };
}

export function temporalContext(value: string | number | Date, timezone: string,
  reference?: { at: string; timezone?: string | null }): TemporalContext {
  const originalTimezone = knownTimezone(reference?.timezone);
  return { asOf: zonedInstant(value, timezone), ...(reference ? { reference: {
    at: zonedInstant(reference.at, originalTimezone ?? timezone), originalTimezone,
  } } : {}) };
}

/** UTC bounds of one local calendar date, excluding the end; missing civil dates are rejected. */
export function localDayRange(localDate: string, timezone: string): { from: string; until: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new RangeError('当地日期须为 YYYY-MM-DD。');
  const [year, month, day] = localDate.split('-').map(Number);
  const nominal = utcCalendarDate(year, month, day);
  if (year < 1 || nominal.toISOString().slice(0, 10) !== localDate) throw new RangeError('当地日期无效。');
  const next = new Date(nominal.getTime() + 86400000).toISOString().slice(0, 10);
  const dateAt = (at: number) => {
    const value = parts(new Date(at), timezone);
    return `${value.year.padStart(4, '0')}-${value.month}-${value.day}`;
  };
  const boundary = (target: string): number => {
    let lower = nominal.getTime() - 48 * 3600000;
    let upper = nominal.getTime() + 72 * 3600000;
    while (upper - lower > 1) {
      const middle = Math.floor((lower + upper) / 2);
      if (dateAt(middle) < target) lower = middle; else upper = middle;
    }
    return upper;
  };
  const from = boundary(localDate);
  const until = boundary(next);
  if (dateAt(from) !== localDate || until <= from) throw new RangeError('该时区不存在此当地日期。');
  return { from: new Date(from).toISOString(), until: new Date(until).toISOString() };
}

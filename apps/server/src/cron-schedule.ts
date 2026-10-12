/**
 * Pure 5-field cron schedule math (no imports — deterministic and
 * unit-testable). Supports `*`, `*\/step`, `a-b`, `a-b/step`, comma
 * lists, integers, and 3-letter `mon..sun` / `jan..dec` (case-
 * insensitive). `@`-forms and anything else parse to null.
 */

/** 3-letter month names for the month field. */
export const MONTH_NAMES: Record<string, number> = {  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** 3-letter weekday names for the day-of-week field (7 parses as Sunday). */
export const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** Parsed cron field (closed value set). */
export interface CronField {
  values: Set<number>;
  /** True when the field was a bare `*` (matters for dom/dow OR rule). */
  star: boolean;
}

function tokenValue(token: string, names: Record<string, number> | undefined): number | null {
  const lower = token.toLowerCase();
  if (names !== undefined && lower in names) return names[lower] as number;
  if (!/^\d+$/.test(token)) return null;
  return Number.parseInt(token, 10);
}

/**
 * Parse one cron field into its value set. Returns null when the field
 * is malformed or any value falls outside `[min, max]` (7 also parses
 * as Sunday in the dow field — normalized to 0).
 */
export function parseCronField(
  field: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): CronField | null {
  if (field === '*') {
    const values = new Set<number>();
    for (let v = min; v <= max; v++) values.add(v);
    return { values, star: true };
  }
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '') return null;
    const [range, stepRaw] = part.split('/');
    if (range === undefined) return null;
    const step = stepRaw === undefined ? 1 : Number.parseInt(stepRaw, 10);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number | null;
    let hi: number | null;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      const aVal = a === undefined ? null : tokenValue(a, names);
      const bVal = b === undefined ? null : tokenValue(b, names);
      if (aVal === null || bVal === null || aVal > bVal) return null;
      lo = aVal;
      hi = bVal;
    } else {
      const single = tokenValue(range, names);
      if (single === null) return null;
      lo = single;
      hi = single;
    }
    // Sunday may be written as 7 in the day-of-week field.
    if (lo < min || hi > max) return null;
    for (let v = lo; v <= hi; v += step) {
      values.add(names === DOW_NAMES && v === 7 ? 0 : v);
    }
  }
  return values.size === 0 ? null : { values, star: false };
}

/** Parsed 5-field schedule (null when any field is malformed). */
export interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

/** Parse `min hour dom month dow` (exactly 5 whitespace parts). */
export function parseCronSchedule(schedule: string): CronSchedule | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts.map((p, i) => {
    switch (i) {
      case 0: return parseCronField(p, 0, 59);
      case 1: return parseCronField(p, 0, 23);
      case 2: return parseCronField(p, 1, 31);
      case 3: return parseCronField(p, 1, 12, MONTH_NAMES);
      default: return parseCronField(p, 0, 7, DOW_NAMES);
    }
  });
  if (minute === undefined || hour === undefined || dom === undefined || month === undefined || dow === undefined) {
    return null;
  }
  if (minute === null || hour === null || dom === null || month === null || dow === null) return null;
  return { minute, hour, dom, month, dow };
}

const YEAR_CAP_MINUTES = 366 * 24 * 60;

/**
 * Next fire time in epoch millis, strictly after `fromMs`. Standard
 * dom-vs-dow OR rule: when one of them is `*`, the other decides;
 * when both are restricted, either may match. Returns null for
 * unparseable schedules or no fire within a year.
 *
 * @param schedule - 5-field cron expression.
 * @param fromMs - Exclusive lower bound (epoch millis).
 */
export function nextRunMs(schedule: string, fromMs: number): number | null {
  const parsed = parseCronSchedule(schedule);
  if (parsed === null) return null;
  // Align to the next whole minute after fromMs.
  let cursor = Math.floor(fromMs / 60000) * 60000 + 60000;
  for (let i = 0; i < YEAR_CAP_MINUTES; i++, cursor += 60000) {
    const d = new Date(cursor);
    if (!parsed.minute.values.has(d.getMinutes())) continue;
    if (!parsed.hour.values.has(d.getHours())) continue;
    if (!parsed.month.values.has(d.getMonth() + 1)) continue;
    const domMatch = parsed.dom.values.has(d.getDate());
    const dowMatch = parsed.dow.values.has(d.getDay());
    const dayMatch = parsed.dom.star && parsed.dow.star
      ? true
      : parsed.dom.star
        ? dowMatch
        : parsed.dow.star
          ? domMatch
          : domMatch || dowMatch;
    if (!dayMatch) continue;
    return cursor;
  }
  return null;
}

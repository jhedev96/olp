import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOW_NAMES, MONTH_NAMES, nextRunMs, parseCronField, parseCronSchedule } from '../src/cron-schedule.js';
import { fileRunStore, memoryRunStore } from '../src/cron-runs.js';
import type { RunRecord } from '../src/cron-runs.js';

// 2026-10-12T10:00:00Z is a Monday.
const MON_10AM = Date.UTC(2026, 9, 12, 10, 0, 0);

describe('cron field parser', () => {
  it('parses stars, steps, ranges, lists and names', () => {
    expect(parseCronField('*', 0, 59)?.values.has(30)).toBe(true);
    expect(parseCronField('*/15', 0, 59)?.values).toEqual(new Set([0, 15, 30, 45]));
    expect(parseCronField('2-4', 0, 59)?.values).toEqual(new Set([2, 3, 4]));
    expect(parseCronField('1,3,5', 0, 59)?.values).toEqual(new Set([1, 3, 5]));
    expect(parseCronField('mon,wed', 0, 7, DOW_NAMES)?.values).toEqual(new Set([1, 3]));
    expect(parseCronField('JAN', 1, 12, MONTH_NAMES)?.values).toEqual(new Set([1]));
    expect(parseCronField('7', 0, 7, DOW_NAMES)?.values).toEqual(new Set([0]));
    expect(parseCronField('5-7', 0, 7, DOW_NAMES)?.values).toEqual(new Set([5, 6, 0]));
  });

  it('rejects malformed fields', () => {
    for (const bad of ['', '*/0', 'a', '5-2', '60', '-1', '1,,2', '*/x', 'mon-funday']) {
      expect(parseCronField(bad, 0, 59)).toBeNull();
    }
    expect(parseCronField('60', 0, 59)).toBeNull();
    expect(parseCronField('*', 0, 59)?.star).toBe(true);
    expect(parseCronField('*/15', 0, 59)?.star).toBe(false);
  });

  it('parses full schedules strictly', () => {
    expect(parseCronSchedule('0 2 * * *')).not.toBeNull();
    expect(parseCronSchedule('0 2 * *')).toBeNull();
    expect(parseCronSchedule('@reboot')).toBeNull();
    expect(parseCronSchedule('0 2 * * mon-funday')).toBeNull();
  });
});

describe('nextRunMs', () => {
  it('finds the next minute strictly after fromMs', () => {
    expect(nextRunMs('* * * * *', MON_10AM)).toBe(MON_10AM + 60000);
    expect(nextRunMs('0 2 * * *', MON_10AM)).toBe(Date.UTC(2026, 9, 13, 2, 0, 0));
    expect(nextRunMs('30 10 * * mon', MON_10AM)).toBe(Date.UTC(2026, 9, 12, 10, 30, 0));
    expect(nextRunMs('*/15 * * * *', MON_10AM)).toBe(Date.UTC(2026, 9, 12, 10, 15, 0));
  });

  it('applies the dom/dow OR rule', () => {
    // 2026-10-12 is Monday the 12th: next Monday midnight is the 19th.
    expect(nextRunMs('0 0 * * mon', MON_10AM)).toBe(Date.UTC(2026, 9, 19, 0, 0, 0));
    expect(nextRunMs('0 0 15 * *', MON_10AM)).toBe(Date.UTC(2026, 9, 15, 0, 0, 0));
    // Both restricted: either may match (13th Tue 00:00 beats 15th).
    expect(nextRunMs('0 0 15 * tue', MON_10AM)).toBe(Date.UTC(2026, 9, 13, 0, 0, 0));
  });

  it('returns null for garbage and impossible schedules', () => {
    expect(nextRunMs('nonsense', MON_10AM)).toBeNull();
    expect(nextRunMs('@reboot', MON_10AM)).toBeNull();
    expect(nextRunMs('0 0 30 2 *', MON_10AM)).toBeNull(); // Feb 30 never comes
  });
});

function record(id: string): RunRecord {
  return {
    id,
    jobId: 'j1',
    name: 'nightly',
    command: 'echo hi',
    startedAt: 1000,
    finishedAt: 1200,
    exitCode: 0,
    timedOut: false,
    latencyMs: 200,
    output: 'hi\n',
  };
}

describe('run stores', () => {
  it('memory store lists newest-first with cap and limit', () => {
    const store = memoryRunStore(2);
    store.append(record('a'));
    store.append(record('b'));
    store.append(record('c'));
    expect(store.list(10).map((r) => r.id)).toEqual(['c', 'b']);
    expect(store.list(1).map((r) => r.id)).toEqual(['c']);
  });

  it('file store round-trips with 0600 perms and floors corruption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olp-runs-'));
    const path = join(dir, 'cron-runs.json');
    const store = fileRunStore(path, 2);
    store.append(record('a'));
    store.append(record('b'));
    store.append(record('c'));
    expect(store.list(10).map((r) => r.id)).toEqual(['c', 'b']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, 'not json{');
    expect(fileRunStore(path).list(10)).toEqual([]);
    expect(fileRunStore(join(dir, 'missing.json')).list(10)).toEqual([]);
  });

  it('reads back exact records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olp-runs-'));
    const path = join(dir, 'cron-runs.json');
    const store = fileRunStore(path);
    store.append(record('a'));
    expect(store.list(10)).toEqual([record('a')]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { DIFF_MAX_LINES, diffLines } from '../src/lib/line-diff.js';

describe('web line-diff', () => {
  it('answers empty for identical inputs', () => {
    expect(diffLines('a\nb\n', 'a\nb\n')).toEqual([]);
    expect(diffLines('', '')).toEqual([]);
  });

  it('shapes pure additions and deletions', () => {
    const hunks = diffLines('a\n', 'a\nb\nc\n');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.header).toBe('@@ -1,2 +1,4 @@');
    expect(hunks[0]?.lines.map((l) => l.type)).toEqual(['context', 'add', 'add', 'context']);
    expect(hunks[0]?.lines[1]).toMatchObject({ type: 'add', text: 'b', bLine: 2 });

    const dels = diffLines('a\nb\nc\n', 'a\nc\n');
    expect(dels[0]?.lines.map((l) => l.type)).toEqual(['context', 'del', 'context', 'context']);
    expect(dels[0]?.lines[1]).toMatchObject({ type: 'del', text: 'b', aLine: 2 });
  });

  it('orders deletions before additions on changed lines', () => {
    const hunks = diffLines('x\n', 'y\n', 0);
    expect(hunks[0]?.lines.map((l) => l.type)).toEqual(['del', 'add']);
  });

  it('windows context and splits distant hunks', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].join('\n');
    const b = ['1', 'X', '3', '4', '5', '6', '7', '8', '9', '10', '11', 'Y'].join('\n');
    const hunks = diffLines(a, b, 1);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.lines.map((l) => l.type)).toEqual(['context', 'del', 'add', 'context']);
    expect(hunks[1]?.lines.map((l) => l.type)).toEqual(['context', 'del', 'add']);
  });

  it('diffs empty against content', () => {
    const hunks = diffLines('', 'hello\n');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines.map((l) => l.type)).toEqual(['add', 'add']);
  });

  it('refuses oversized inputs instead of hanging', () => {
    const big = Array.from({ length: DIFF_MAX_LINES }, (_, i) => `line ${i}`).join('\n');
    expect(() => diffLines(big, `${big}\none more`)).toThrow(/diff too large/);
  });
});

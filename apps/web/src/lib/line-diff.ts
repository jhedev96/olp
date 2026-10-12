/** One rendered diff row (line numbers refer to original `a` / edited `b`). */
export type DiffLine =
  | { type: 'context'; text: string; aLine: number; bLine: number }
  | { type: 'del'; text: string; aLine: number }
  | { type: 'add'; text: string; bLine: number };

/** One hunk (`@@ -a,b +c,d @@` header + rows). */
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/** Refuse past this many total lines (DP is quadratic — never hang the tab). */
export const DIFF_MAX_LINES = 10000;

/** Hunk context lines on each side (unified-diff convention). */
const CONTEXT = 3;

type Op = { kind: 'same' | 'del' | 'add'; text: string };

/**
 * Line diff (`a` = opened snapshot, `b` = current content). Common
 * prefix/suffix trim first, Myers-style LCS DP on the changed middle
 * only, then hunk assembly with `context` lines of padding.
 * Identical inputs answer `[]`; oversized inputs throw (the UI shows
 * the message instead of hanging).
 */
export function diffLines(a: string, b: string, context: number = CONTEXT): DiffHunk[] {
  const aLines = a === '' ? [] : a.split('\n');
  const bLines = b === '' ? [] : b.split('\n');
  if (aLines.length + bLines.length > DIFF_MAX_LINES) {
    throw new Error(`diff too large (${aLines.length + bLines.length} lines, max ${DIFF_MAX_LINES})`);
  }
  let head = 0;
  while (head < aLines.length && head < bLines.length && aLines[head] === bLines[head]) head++;
  let aTail = aLines.length;
  let bTail = bLines.length;
  while (aTail > head && bTail > head && aLines[aTail - 1] === bLines[bTail - 1]) {
    aTail--;
    bTail--;
  }
  const aMid = aLines.slice(head, aTail);
  const bMid = bLines.slice(head, bTail);
  const ops = lcs(aMid, bMid);

  // Full op stream with 1-based line numbers.
  const flat: Array<Op & { aLine?: number; bLine?: number }> = [];
  for (let i = 0; i < head; i++) flat.push({ kind: 'same', text: aLines[i] ?? '', aLine: i + 1, bLine: i + 1 });
  let ai = head + 1;
  let bi = head + 1;
  for (const op of ops) {
    if (op.kind === 'same') {
      flat.push({ ...op, aLine: ai, bLine: bi });
      ai++;
      bi++;
    } else if (op.kind === 'del') {
      flat.push({ ...op, aLine: ai });
      ai++;
    } else {
      flat.push({ ...op, bLine: bi });
      bi++;
    }
  }
  for (let i = aTail; i < aLines.length; i++) {
    flat.push({ kind: 'same', text: aLines[i] ?? '', aLine: i + 1, bLine: bTail + (i - aTail) + 1 });
  }

  // Hunk assembly: changed rows plus `context` padding, merged on overlap.
  const changed = new Set<number>();
  flat.forEach((op, i) => {
    if (op.kind !== 'same') {
      for (let j = Math.max(0, i - context); j <= Math.min(flat.length - 1, i + context); j++) changed.add(j);
    }
  });
  if (changed.size === 0) return [];
  const hunks: DiffHunk[] = [];
  let run: number[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const rows = run.map((i) => flat[i]).filter((op) => op !== undefined);
    const aNums = rows.map((op) => op.aLine).filter((n) => n !== undefined);
    const bNums = rows.map((op) => op.bLine).filter((n) => n !== undefined);
    const aStart = aNums[0] ?? 1;
    const bStart = bNums[0] ?? 1;
    hunks.push({
      header: `@@ -${aStart},${aNums.length} +${bStart},${bNums.length} @@`,
      lines: rows.map((op): DiffLine => {
        if (op.kind === 'same') return { type: 'context', text: op.text, aLine: op.aLine ?? 0, bLine: op.bLine ?? 0 };
        if (op.kind === 'del') return { type: 'del', text: op.text, aLine: op.aLine ?? 0 };
        return { type: 'add', text: op.text, bLine: op.bLine ?? 0 };
      }),
    });
    run = [];
  };
  const sorted = [...changed].sort((x, y) => x - y);
  let prev = -2;
  for (const i of sorted) {
    if (i !== prev + 1) flush();
    run.push(i);
    prev = i;
  }
  flush();
  return hunks;
}

/** LCS edit script for the trimmed middle (DP over `Int32Array` rows). */
function lcs(aMid: string[], bMid: string[]): Op[] {
  const n = aMid.length;
  const m = bMid.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        aMid[i] === bMid[j]
          ? (dp[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + (j + 1)] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aMid[i] === bMid[j]) {
      ops.push({ kind: 'same', text: aMid[i] ?? '' });
      i++;
      j++;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + (j + 1)] ?? 0)) {
      // Ties delete first (unified-diff convention: `-` rows before `+`).
      ops.push({ kind: 'del', text: aMid[i] ?? '' });
      i++;
    } else {
      ops.push({ kind: 'add', text: bMid[j] ?? '' });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: aMid[i] ?? '' });
    i++;
  }
  while (j < m) {
    ops.push({ kind: 'add', text: bMid[j] ?? '' });
    j++;
  }
  return ops;
}

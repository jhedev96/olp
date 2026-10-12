/**
 * Formatting helpers (Terwo `app.js` parity: same units, same thresholds).
 * All user-controlled strings go through `esc()` before `innerHTML`.
 */

/** `1023` → `1023 B`, `2048` → `2.0 KB`, etc. (Terwo `fmtSize` parity). */
export function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** Millis epoch → `en-US` locale string (Terwo `fmtDate` parity). */
export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString('en-US');
}

/** Seconds → `2d 3h` / `3h 15m` / `15m` (Terwo `fmtUptime` parity). */
export function fmtUptime(sec: number): string {
  const total = Math.floor(sec || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Millis epoch → `just now` / `5m ago` / `2h ago` / `Yesterday` / `3d ago` (sessions table). */
export function fmtAgo(ms: number, now: number = Date.now()): string {
  const mins = Math.floor(Math.max(0, now - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return 'Yesterday';
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * HTML-escape anything interpolated into markup — the single XSS line
 * of defense. Numbers/booleans stringify safely; objects stringify too.
 */
export function esc(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Dark/light theme (Terwo parity: dark default, persisted toggle).
 * Key migrated `terwo-theme` → `olp-theme` with read-through:
 * the legacy value is honored once, then stored under the new key.
 */

export type Theme = 'dark' | 'light';

const KEY = 'olp-theme';
const LEGACY_KEY = 'terwo-theme';

/** Minimal storage surface (real `localStorage` in production). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Minimal document surface for the theme class. */
export interface DocumentLike {
  documentElement: { classList: { toggle(token: string, force?: boolean): void } };
}

/** Read the theme: new key, then legacy key, then dark default. */
export function getTheme(storage: StorageLike = localStorage): Theme {
  const value = storage.getItem(KEY) ?? storage.getItem(LEGACY_KEY);
  return value === 'light' || value === 'dark' ? value : 'dark';
}

/** Persist the theme and reflect it via `<html class="light">` (Terwo parity). */
export function setTheme(
  theme: Theme,
  storage: StorageLike = localStorage,
  doc: DocumentLike = document,
): void {
  storage.setItem(KEY, theme);
  doc.documentElement.classList.toggle('light', theme === 'light');
}

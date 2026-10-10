/**
 * Slug router (Terwo tab/slug parity). No reloads: `navigate()` pushes
 * history and the caller renders; browser back/forward arrives via
 * `popstate`, which `main.ts` maps back through `slugFromPath`.
 */

export type Slug =
  | 'login'
  | 'dashboard'
  | 'website'
  | 'database'
  | 'files'
  | 'cron'
  | 'backup'
  | 'settings'
  | 'terminal'
  | 'store';

const SLUGS: readonly Slug[] = [
  'login',
  'dashboard',
  'website',
  'database',
  'files',
  'cron',
  'backup',
  'settings',
  'terminal',
  'store',
];

/** Minimal history surface (real `window.history` in production). */
export interface HistoryLike {
  pushState(data: unknown, title: string, url?: string | URL | null): void;
}

/**
 * Map a path to its slug; unknown paths fall back to `dashboard`
 * (the server still gates unauthenticated access — this is UX only).
 */
export function slugFromPath(path: string): Slug {
  const clean = path.replace(/^\/+|\/+$/g, '');
  return (SLUGS as readonly string[]).includes(clean) ? (clean as Slug) : 'dashboard';
}

/**
 * Push a slug onto history. Rendering stays with the caller (same as
 * Terwo `showTab`, which pushes and paints in one step).
 */
export function navigate(slug: Slug, history: HistoryLike = window.history): void {
  history.pushState({ slug }, '', `/${slug}`);
}

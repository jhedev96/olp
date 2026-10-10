/**
 * OLP web skeleton with Terwo-compatible clean slugs.
 *
 * No framework yet: renders a nav plus a placeholder per route.
 * Real pages land here during Phase 3 (one page module per slug).
 */

const SLUGS: readonly string[] = [
  '/login',
  '/dashboard',
  '/website',
  '/database',
  '/files',
  '/cron',
  '/backup',
  '/settings',
  '/terminal',
  '/store',
];

/**
 * Render the skeleton UI for the current path.
 *
 * @param path - Current `window.location.pathname`.
 * @returns Main heading text for the path (used by tests/smoke).
 */
export function headingFor(path: string): string {
  if (path === '/' || path === '') return 'OpenLocalPanel';
  if ((SLUGS as readonly string[]).includes(path)) {
    const name = path.slice(1);
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return 'Not found';
}

function render(): void {
  const root = document.getElementById('app');
  if (!root) return;
  const path = window.location.pathname;
  const heading = headingFor(path);
  const nav = SLUGS.map((s) => `<a href="${s}">${s}</a>`).join(' | ');
  root.innerHTML =
    `<nav>${nav}</nav>` +
    `<main><h1>${heading}</h1><p>OLP skeleton — ${path}</p></main>`;
  for (const a of Array.from(root.querySelectorAll('a'))) {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const href = (ev.currentTarget as HTMLAnchorElement).getAttribute('href') ?? '/';
      window.history.pushState({}, '', href);
      render();
    });
  }
}

window.addEventListener('popstate', render);
render();

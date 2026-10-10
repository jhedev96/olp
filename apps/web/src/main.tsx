import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { navigate, slugFromPath } from './lib/router.js';
import type { Slug } from './lib/router.js';
import { getTheme, setTheme } from './lib/theme.js';
import { LoginPage } from './pages/login.js';
import './styles/index.css';

const PLACEHOLDER_SLUGS: readonly Slug[] = [
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

/**
 * App boot: applies the theme, renders the slug route, and re-renders on
 * back/forward. `/login` mounts the React login page; other slugs render
 * placeholders until their pages land (one root per mode, unmounted on
 * switch so React and raw DOM never share the container).
 */
let reactRoot: Root | null = null;

function unmountReact(): void {
  reactRoot?.unmount();
  reactRoot = null;
}

function render(): void {
  const root = document.getElementById('app');
  if (root === null) return;
  const slug = slugFromPath(window.location.pathname);
  if (slug === 'login') {
    if (reactRoot === null) reactRoot = createRoot(root);
    reactRoot.render(
      <StrictMode>
        <LoginPage />
      </StrictMode>,
    );
    return;
  }
  unmountReact();
  const pretty = slug.charAt(0).toUpperCase() + slug.slice(1);
  const links = (['login', ...PLACEHOLDER_SLUGS] as const)
    .map((s) => `<a href="/${s}">${s}</a>`)
    .join(' | ');
  root.innerHTML = `<nav>${links}</nav><main><h1>${pretty}</h1><p>OLP — ${slug} page coming soon.</p></main>`;
  for (const anchor of Array.from(root.querySelectorAll('a'))) {
    anchor.addEventListener('click', (ev) => {
      ev.preventDefault();
      const href = (ev.currentTarget as HTMLAnchorElement).getAttribute('href') ?? '/';
      navigate(slugFromPath(href));
      render();
    });
  }
}

setTheme(getTheme());
window.addEventListener('popstate', render);
render();

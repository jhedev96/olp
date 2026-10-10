import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { AppShell } from './components/shell/AppShell.js';
import { slugFromPath } from './lib/router.js';
import { getTheme, setTheme } from './lib/theme.js';
import { BackupPage } from './pages/backup.js';
import { CronPage } from './pages/cron.js';
import { DashboardPage } from './pages/dashboard.js';
import { DatabasePage } from './pages/database.js';
import { FilesPage } from './pages/files.js';
import { LoginPage } from './pages/login.js';
import { MonitorPage } from './pages/monitor.js';
import { SettingsPage } from './pages/settings.js';
import { SitesPage } from './pages/sites.js';
import { StorePage } from './pages/store.js';
import { TerminalPage } from './pages/terminal.js';
import './styles/index.css';

const PAGES = {
  login: LoginPage,
  dashboard: DashboardPage,
  files: FilesPage,
  terminal: TerminalPage,
  website: SitesPage,
  database: DatabasePage,
  store: StorePage,
  cron: CronPage,
  backup: BackupPage,
  settings: SettingsPage,
  monitor: MonitorPage,
} as const;

/**
 * App boot: applies the theme, renders the slug route inside the shell
 * (login stays shell-less), and re-renders on back/forward plus
 * in-app `navigateTo()` calls (both arrive as `popstate`).
 * One React root for the whole SPA. (The server still gates everything —
 * the router is UX only.)
 */
let root: Root | null = null;

function render(): void {
  const el = document.getElementById('app');
  if (el === null) return;
  const slug = slugFromPath(window.location.pathname);
  const Page = PAGES[slug];
  if (root === null) root = createRoot(el);
  root.render(
    <StrictMode>
      {slug === 'login' ? <Page /> : <AppShell slug={slug}>{<Page />}</AppShell>}
    </StrictMode>,
  );
}

setTheme(getTheme());
window.addEventListener('popstate', render);
render();

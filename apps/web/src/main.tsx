import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { slugFromPath } from './lib/router.js';
import { getTheme, setTheme } from './lib/theme.js';
import { BackupPage } from './pages/backup.js';
import { CronPage } from './pages/cron.js';
import { DashboardPage } from './pages/dashboard.js';
import { DatabasePage } from './pages/database.js';
import { FilesPage } from './pages/files.js';
import { LoginPage } from './pages/login.js';
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
} as const;

/**
 * App boot: applies the theme, renders the slug route, and re-renders on
 * back/forward. One React root for the whole SPA; nav links use the slug
 * router (no reloads). (The server still gates everything — the router is
 * UX only.)
 */
let root: Root | null = null;

function render(): void {
  const el = document.getElementById('app');
  if (el === null) return;
  const Page = PAGES[slugFromPath(window.location.pathname)];
  if (root === null) root = createRoot(el);
  root.render(
    <StrictMode>
      <Page />
    </StrictMode>,
  );
}

setTheme(getTheme());
window.addEventListener('popstate', render);
render();

import type { ReactElement, ReactNode } from 'react';
import type { Slug } from '../../lib/router.js';
import { Header } from './Header.js';
import { Sidebar, titleFor } from './Sidebar.js';

/**
 * App shell: fixed sidebar + sticky header + page outlet.
 * Login renders shell-less; every other slug renders inside.
 * Content carries bottom padding for the mobile tab bar (`md:pb-0`
 * restores desktop spacing).
 */
export function AppShell({ slug, children }: { slug: Slug; children: ReactNode }): ReactElement {
  const title = titleFor(slug);
  return (
    <div className="min-h-screen bg-surface text-neutral-200">
      <Sidebar slug={slug} />
      <div className="md:pl-64">
        <Header title={title} />
        <div className="pb-20 md:pb-8">{children}</div>
      </div>
    </div>
  );
}

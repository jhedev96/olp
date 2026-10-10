import type { ReactElement } from 'react';
import { APP_VERSION } from '../../lib/version.js';
import logoUrl from '../../assets/logo.svg?url';

/**
 * Brand block (mockup sidebar brand-row parity, rebranded).
 * Glyph + `olp` wordmark ship as a self-hosted SVG (never hotlinked);
 * the version badge is HTML so releases update it without redrawing art.
 */
export function BrandBlock({ version = APP_VERSION }: { version?: string }): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <img src={logoUrl} alt="OpenLocalPanel" className="h-9 w-auto" />
      <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-300">
        v{version}
      </span>
    </div>
  );
}

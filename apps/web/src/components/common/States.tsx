import type { ReactElement, ReactNode } from 'react';
import { Badge } from './Badge.js';

/**
 * Coming-Soon dummy (no-drop rule §10.2): real layout stays, controls
 * stay disabled, and the badge carries the CANDIDATES.md id so the
 * backlog stays honest (tests assert the id renders).
 */
export function ComingSoon({ feature, candidate }: { feature: string; candidate: string }): ReactElement {
  return (
    <section aria-disabled="true" aria-label={`${feature} (coming soon)`} className="rounded-lg border border-dashed border-neutral-700 p-4 opacity-70">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-bold">{feature}</h3>
        <Badge tone="info" title="Tracked in .opencode/plan/CANDIDATES.md">
          {candidate}
        </Badge>
        <span className="text-xs text-neutral-400">Coming soon</span>
      </div>
      <p className="mt-1 text-sm text-neutral-400">Needs a backend wave — nothing here is live data.</p>
    </section>
  );
}

/** Centered empty-list block with an optional action slot (buttons/links). */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
      <p className="text-sm font-medium text-neutral-300">{title}</p>
      {hint !== undefined && hint !== '' && <p className="text-xs text-neutral-500">{hint}</p>}
      {action}
    </div>
  );
}

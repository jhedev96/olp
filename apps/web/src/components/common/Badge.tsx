import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

/** Badge tones (status pills across pages — Running, Stopped, Coming-Soon). */
export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-neutral-700 text-neutral-300',
  success: 'border-emerald-500/30 text-emerald-300',
  warning: 'border-yellow-500/30 text-yellow-300',
  danger: 'border-red-500/30 text-red-400',
  info: 'border-sky-500/30 text-sky-300',
};

/** Small status pill (presentational only — callers pick the tone). */
export function Badge({
  tone = 'neutral',
  children,
  className,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
}): ReactElement {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

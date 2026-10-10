import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils.js';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** Themed text input (shadcn API shape, OLP palette). */
export function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cn(
        'flex h-9 w-full rounded-md border border-neutral-700 bg-transparent px-3 py-1 text-sm placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-green-600 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes (shadcn `cn` parity). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

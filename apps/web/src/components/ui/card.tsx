import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.js';

/** Card shell (shadcn API shape, OLP palette). */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-neutral-800 bg-neutral-900 p-6', className)} {...props} />;
}

/** Card title row. */
export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h1 className={cn('text-xl font-bold tracking-tight', className)} {...props} />;
}

/** Card body section. */
export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-4 flex flex-col gap-3', className)} {...props} />;
}

import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils.js';

/** shadcn-style button variants (subset needed by OLP pages). */
const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-green-600 text-white hover:bg-green-700',
        destructive: 'bg-red-600 text-white hover:bg-red-700',
        outline: 'border border-neutral-700 hover:bg-neutral-800',
        ghost: 'hover:bg-neutral-800',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3 text-xs',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

/** Themed button (shadcn API shape, OLP palette). */
export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';

/**
 * Modal shell (shadcn-style, no new deps): centered panel over a dimmed
 * overlay. Escape and overlay clicks cancel; closed renders nothing.
 * Pages compose `ConfirmDialog` / `PromptDialog` on top — never this
 * directly unless a custom body is needed.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}): ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-5">
        <h2 className="font-bold tracking-tight">{title}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

/**
 * Confirm replacement for the native blocking confirm: destructive actions keep the
 * two-step (caller opens, user confirms). `busy` disables both buttons
 * while the confirmed action runs.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement | null {
  return (
    <Dialog open={open} title={title} onClose={onCancel}>
      <p className="text-sm text-neutral-300">{message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button size="sm" variant={destructive ? 'destructive' : 'default'} disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * Prompt replacement for the native blocking prompt: single text input with submit
 * on Enter. The input resets to `initialValue` on every open so stale
 * edits never leak between invocations.
 */
export function PromptDialog({
  open,
  title,
  initialValue = '',
  placeholder,
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}): ReactElement | null {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  return (
    <Dialog open={open} title={title} onClose={onCancel}>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          onSubmit(value);
        }}
        className="flex flex-col gap-3"
      >
        <Input autoFocus placeholder={placeholder} value={value} onChange={(ev) => setValue(ev.target.value)} />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" type="button" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button size="sm" type="submit">
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

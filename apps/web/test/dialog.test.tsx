// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog, Dialog, PromptDialog } from '../src/components/common/Dialog.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('web dialog shell', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Dialog open={false} title="Hidden" onClose={() => {}}>
        <p>body</p>
      </Dialog>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('cancels on Escape and on overlay click', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog open={true} title="Open" onClose={onClose}>
        <p>body</p>
      </Dialog>,
    );
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    const overlay = container.firstElementChild;
    fireEvent.mouseDown(overlay!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('web confirm dialog', () => {
  it('confirms and cancels with custom labels', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open={true}
        title="Delete site?"
        message="This cannot be undone."
        confirmLabel="Delete"
        destructive={true}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText('This cannot be undone.')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    const del = screen.getByRole('button', { name: 'Delete' });
    expect(del.className).toContain('bg-red-600');
    fireEvent.click(del);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while busy', () => {
    render(
      <ConfirmDialog open={true} title="Busy" message="Wait." busy={true} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
  });
});

describe('web prompt dialog', () => {
  it('submits the edited value and resets per open', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <PromptDialog open={true} title="New name" initialValue="old.txt" onSubmit={onSubmit} onCancel={onCancel} />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('old.txt');
    fireEvent.change(input, { target: { value: 'new.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit.mock.calls).toEqual([['new.txt']]);
    expect(onCancel).not.toHaveBeenCalled();

    rerender(
      <PromptDialog open={false} title="New name" initialValue="other.txt" onSubmit={onSubmit} onCancel={onCancel} />,
    );
    rerender(
      <PromptDialog open={true} title="New name" initialValue="other.txt" onSubmit={onSubmit} onCancel={onCancel} />,
    );
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('other.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

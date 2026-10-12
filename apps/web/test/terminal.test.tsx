// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { TerminalPage } from '../src/pages/terminal.js';
import type { TermLike, TermSocket } from '../src/pages/terminal.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
});

class FakeTerm implements TermLike {
  written: string[] = [];
  cleared = 0;
  disposed = false;
  focused = false;
  cols = 80;
  rows = 24;
  selection = '';
  private dataCb: (data: string) => void = () => {};

  open(): void {}
  loadAddon(): void {}
  onData(cb: (data: string) => void): { dispose(): void } {
    this.dataCb = cb;
    return { dispose: () => {} };
  }
  write(data: string): void {
    this.written.push(data);
  }
  clear(): void {
    this.cleared++;
  }
  focus(): void {
    this.focused = true;
  }
  dispose(): void {
    this.disposed = true;
  }
  attachCustomKeyEventHandler(): boolean {
    return true;
  }
  getSelection(): string {
    return this.selection;
  }
  setOption(key: string, value: unknown): void {
    if (key === 'fontSize' && typeof value === 'number') this.fontPx = value;
  }
  fontPx = 14;
  emitInput(data: string): void {
    this.dataCb(data);
  }
}

class FakeSocket implements TermSocket {
  sent: string[] = [];
  closed = false;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  readyState = 1;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.(new Event('open'));
  }
  receive(text: string): void {
    this.onmessage?.(new MessageEvent('message', { data: text }));
  }
  drop(): void {
    this.onclose?.(new CloseEvent('close'));
  }
}

function mounted(): { term: FakeTerm; sockets: FakeSocket[] } {
  const term = new FakeTerm();
  const sockets: FakeSocket[] = [];
  act(() => {
    render(
      <TerminalPage
        createTerminal={() => ({ term, fit: { fit: () => {} } })}
        connectSocket={() => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        }}
      />,
    );
  });
  return { term, sockets };
}

describe('web terminal page', () => {
  it('connects, resizes, and shows status', () => {
    const { sockets } = mounted();
    expect(sockets).toHaveLength(1);
    act(() => {
      sockets[0]?.open();
    });
    expect(screen.getByText('Connected')).not.toBeNull();
    expect(sockets[0]?.sent[0]).toBe(JSON.stringify({ t: 'rs', c: 80, r: 24 }));
  });

  it('sends input and writes output, flagging pipe mode', () => {
    const { term, sockets } = mounted();
    act(() => {
      sockets[0]?.open();
    });
    act(() => {
      term.emitInput('ls\n');
    });
    expect(sockets[0]?.sent).toContain(JSON.stringify({ t: 'in', d: 'ls\n' }));
    act(() => {
      sockets[0]?.receive('total 0 (sh, pipe)');
    });
    expect(term.written).toContain('total 0 (sh, pipe)');
    expect(screen.getByText('pipe mode (no pty)')).not.toBeNull();
    act(() => {
      sockets[0]?.receive(JSON.stringify({ t: 'out', d: 'hi' }));
    });
    expect(term.written).toContain('hi');
  });

  it('applies sticky ctrl/alt and keymap keys', () => {
    const { term, sockets } = mounted();
    act(() => {
      sockets[0]?.open();
    });
    act(() => {
      fireEvent.click(screen.getByText('Ctrl'));
    });
    act(() => {
      term.emitInput('c');
    });
    expect(sockets[0]?.sent).toContain(JSON.stringify({ t: 'in', d: '\x03' }));
    act(() => {
      fireEvent.click(screen.getByText('Alt'));
    });
    act(() => {
      term.emitInput('|');
    });
    expect(sockets[0]?.sent).toContain(JSON.stringify({ t: 'in', d: '\x1b|' }));
    act(() => {
      fireEvent.click(screen.getByText('esc'));
    });
    expect(sockets[0]?.sent).toContain(JSON.stringify({ t: 'in', d: '\x1b' }));
  });

  it('creates new sessions with dialog and clears', () => {
    const { term, sockets } = mounted();
    act(() => {
      sockets[0]?.open();
    });
    act(() => {
      fireEvent.click(screen.getByText('New session'));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('will be killed');
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'New session' }));
    });
    expect(sockets[0]?.sent).toContain(JSON.stringify({ t: 'new' }));
    act(() => {
      term.emitInput('x');
    });
    act(() => {
      fireEvent.click(screen.getByText('Clear'));
    });
    expect(term.cleared).toBe(1);
  });

  it('shows disconnected on close', () => {
    const { sockets } = mounted();
    act(() => {
      sockets[0]?.open();
      sockets[0]?.drop();
    });
    expect(screen.getByText('Disconnected')).not.toBeNull();
  });

  it('shows the pty badge and adjusts font size', () => {
    const { term, sockets } = mounted();
    act(() => {
      sockets[0]?.open();
    });
    expect(screen.getByText('pty')).not.toBeNull();
    act(() => {
      fireEvent.click(screen.getByLabelText('Increase font size'));
    });
    expect(term.fontPx).toBe(15);
    expect(screen.getByText('15px')).not.toBeNull();
    act(() => {
      fireEvent.click(screen.getByLabelText('Decrease font size'));
    });
    expect(term.fontPx).toBe(14);
  });

  it('reconnects and executes raw commands', () => {
    const { sockets } = mounted();
    act(() => {
      sockets[0]?.open();
    });
    act(() => {
      fireEvent.click(screen.getByText('Reconnect'));
    });
    expect(sockets[0]?.closed).toBe(true);
    act(() => {
      sockets[1]?.open();
    });
    expect(screen.getByText('Connected')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Send raw command'), { target: { value: 'ls -la' } });
    act(() => {
      fireEvent.click(screen.getByText('Exec'));
    });
    expect(sockets[1]?.sent).toContain(JSON.stringify({ t: 'in', d: 'ls -la\n' }));
    expect((screen.getByLabelText('Send raw command') as HTMLInputElement).value).toBe('');
  });

  it('sends safe presets one-tap', () => {
    const { sockets } = mounted();
    act(() => {
      sockets[0]?.open();
    });
    act(() => {
      fireEvent.click(screen.getByTitle('htop'));
    });
    expect(sockets[0]?.sent).toContain(JSON.stringify({ t: 'in', d: 'htop\n' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirms destructive snippets before sending', () => {
    const { sockets } = mounted();
    act(() => {
      sockets[0]?.open();
    });
    fireEvent.change(screen.getByLabelText('New snippet'), { target: { value: 'killall node' } });
    act(() => {
      fireEvent.click(screen.getByText('Add'));
    });
    act(() => {
      fireEvent.click(screen.getByTitle('killall node'));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('killall node');
    expect(sockets[0]?.sent.some((m) => m.includes('killall'))).toBe(false);
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    });
    expect(sockets[0]?.sent).toContain(JSON.stringify({ t: 'in', d: 'killall node\n' }));
  });

  it('adds, persists, and removes custom snippets', () => {
    const first = mounted();
    act(() => {
      first.sockets[0]?.open();
    });
    fireEvent.change(screen.getByLabelText('New snippet'), { target: { value: 'git log --oneline' } });
    act(() => {
      fireEvent.click(screen.getByText('Add'));
    });
    expect(screen.getByTitle('git log --oneline')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('olp.snippets.v1') ?? 'null')).toEqual(['git log --oneline']);
    fireEvent.change(screen.getByLabelText('New snippet'), { target: { value: 'git log --oneline' } });
    act(() => {
      fireEvent.click(screen.getByText('Add'));
    });
    expect(screen.getByRole('alert').textContent).toBe('Snippet already exists');
    document.body.innerHTML = '';
    mounted();
    expect(screen.getByTitle('git log --oneline')).not.toBeNull();
    act(() => {
      fireEvent.click(screen.getByLabelText('Remove git log --oneline'));
    });
    expect(screen.queryByTitle('git log --oneline')).toBeNull();
    expect(localStorage.getItem('olp.snippets.v1')).toBe('[]');
  });
});

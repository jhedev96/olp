import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Terminal } from 'xterm';
import type { IDisposable } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { wsUrl } from '../lib/api.js';
import { ConfirmDialog } from '../components/common/Dialog.js';
import { Button } from '../components/ui/button.js';

/** Mobile keymap (Terwo `TERM_KEYMAP` parity). */
const KEYMAP: Record<string, string> = {
  esc: '\x1b',
  tab: '\t',
  '|': '|',
  '/': '/',
  pgup: '\x1b[5~',
  pgdn: '\x1b[6~',
  home: '\x1b[H',
  end: '\x1b[F',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
};

/** Minimal xterm surface used by this page (real `Terminal` satisfies it). */
export interface TermLike {
  open(el: HTMLElement): void;
  loadAddon(addon: unknown): void;
  onData(cb: (data: string) => void): IDisposable;
  write(data: string): void;
  clear(): void;
  focus(): void;
  dispose(): void;
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void;
  getSelection(): string;
  /** Live option switch (font size buttons; fakes may omit it). */
  setOption?(key: string, value: unknown): void;
  readonly cols: number;
  readonly rows: number;
}

/** Minimal socket surface (real `WebSocket` satisfies it). */
export interface TermSocket {
  send(data: string): void;
  close(): void;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  readonly readyState: number;
}

/** Injectable factories (tests drive fakes; production uses xterm + WS). */
export interface TerminalPageDeps {
  createTerminal?: () => { term: TermLike; fit: { fit(): void } };
  connectSocket?: (url: string) => TermSocket;
}

function defaultTerminal(): { term: TermLike; fit: { fit(): void } } {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Consolas, monospace',
    theme: { background: '#14171b', foreground: '#e8ecef', cursor: '#20a53a' },
  }) as unknown as TermLike;
  const fit = new FitAddon() as unknown as { fit(): void };
  return { term, fit };
}

/**
 * Terminal page (mockup terminal parity): xterm + fit addon, WS `/term`
 * with `{t:'in'|'rs'|'new'}` protocol, pty/pipe badge, font-size
 * controls, connect/new/clear/paste buttons, right-click paste, mobile
 * keymap with sticky ctrl/alt. Honestly omitted (no source, backend
 * frozen): multi-tab sessions, split panes, per-tab TTY (CAND-017),
 * WS latency badge (CAND-018), kernel line of the MOTD (CAND-014 —
 * the art itself arrives via the server greeting).
 */
export function TerminalPage(deps: TerminalPageDeps = {}): ReactElement {
  const createTerminal = deps.createTerminal ?? defaultTerminal;
  const connectSocket =
    deps.connectSocket ?? ((url: string): TermSocket => new WebSocket(url) as unknown as TermSocket);
  const boxRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<TermLike | null>(null);
  const fitRef = useRef<{ fit(): void } | null>(null);
  const wsRef = useRef<TermSocket | null>(null);
  const stickyRef = useRef({ ctrl: false, alt: false });
  const [status, setStatus] = useState('connecting…');
  const [pipe, setPipe] = useState(false);
  const [hint, setHint] = useState('');
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [fontSize, setFontSize] = useState(14);

  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const { term, fit } = createTerminal();
    termRef.current = term;
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(box);
    try {
      fit.fit();
    } catch {
      // headless/test renderers without layout
    }
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && term.getSelection() !== '') {
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      return true;
    });
    const sendInput = (data: string): void => {
      const out = applySticky(data);
      if (wsRef.current !== null) {
        try {
          wsRef.current.send(JSON.stringify({ t: 'in', d: out }));
        } catch {
          // closed socket: input is dropped like Terwo
        }
      }
    };
    term.onData(sendInput);

    const connect = (): void => {
      setStatus('connecting…');
      const ws = connectSocket(wsUrl('/term'));
      wsRef.current = ws;
      ws.onopen = () => {
        setStatus('Connected');
        try {
          fit.fit();
          ws.send(JSON.stringify({ t: 'rs', c: term.cols, r: term.rows }));
        } catch {
          // resize is best-effort
        }
      };
      ws.onclose = () => setStatus('Disconnected');
      ws.onmessage = (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
        if (text.includes(', pipe)')) setPipe(true);
        try {
          const msg = JSON.parse(text) as { t?: unknown; d?: unknown };
          if (typeof msg === 'object' && msg !== null && msg.t === 'out' && typeof msg.d === 'string') {
            term.write(msg.d);
            return;
          }
        } catch {
          // not JSON: fall through to raw write
        }
        term.write(text);
      };
    };
    connect();

    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            try {
              fit.fit();
            } catch {
              // ignore layout races
            }
          })
        : null;
    observer?.observe(box);
    term.focus();
    return () => {
      observer?.disconnect();
      try {
        wsRef.current?.close();
      } catch {
        // ignore close errors on unmount
      }
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applySticky = (data: string): string => {
    const sticky = stickyRef.current;
    let out = data;
    if (sticky.ctrl && /^[a-zA-Z]$/.test(out)) {
      out = String.fromCharCode(out.toUpperCase().charCodeAt(0) - 64);
    } else if (sticky.alt && out.length === 1) {
      out = `\x1b${out}`;
    }
    if (sticky.ctrl || sticky.alt) {
      sticky.ctrl = false;
      sticky.alt = false;
      setCtrl(false);
      setAlt(false);
    }
    return out;
  };

  const sendKey = (data: string): void => {
    try {
      wsRef.current?.send(JSON.stringify({ t: 'in', d: data }));
    } catch {
      // closed socket: dropped
    }
    try {
      termRef.current?.focus();
    } catch {
      // ignore focus errors
    }
  };

  const createNew = (): void => {
    setConfirmNew(true);
  };

  const confirmCreateNew = (): void => {
    setConfirmNew(false);
    try {
      wsRef.current?.send(JSON.stringify({ t: 'new' }));
    } catch {
      // will reconnect below
    }
  };

  const changeFont = (delta: number): void => {
    const next = Math.min(24, Math.max(10, fontSize + delta));
    setFontSize(next);
    try {
      termRef.current?.setOption?.('fontSize', next);
      fitRef.current?.fit();
    } catch {
      // headless/test renderers without layout
    }
  };

  const paste = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      if (text !== '') sendKey(text);
    } catch {
      setHint('Clipboard is not accessible to the browser. Use Ctrl+Shift+V / right-click.');
    }
  };

  const pressKey = (key: string): void => {
    if (key === 'ctrl') {
      const next = !stickyRef.current.ctrl;
      stickyRef.current = { ctrl: next, alt: false };
      setCtrl(next);
      setAlt(false);
      return;
    }
    if (key === 'alt') {
      const next = !stickyRef.current.alt;
      stickyRef.current = { ctrl: false, alt: next };
      setCtrl(false);
      setAlt(next);
      return;
    }
    sendKey(applySticky(Object.prototype.hasOwnProperty.call(KEYMAP, key) ? (KEYMAP[key] as string) : key));
  };

  return (
    <main className="flex h-full flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">Terminal</h1>
        <span className={status === 'Connected' ? 'text-sm text-green-400' : 'text-sm text-neutral-400'}>{status}</span>
        {pipe ? (
          <span className="text-xs text-yellow-400">pipe mode (no pty)</span>
        ) : (
          <span className="text-xs text-emerald-400">pty</span>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" aria-label="Decrease font size" onClick={() => changeFont(-1)}>
          A-
        </Button>
        <span className="text-xs text-neutral-500">{fontSize}px</span>
        <Button size="sm" variant="ghost" aria-label="Increase font size" onClick={() => changeFont(1)}>
          A+
        </Button>
        <Button size="sm" variant="outline" onClick={() => termRef.current?.clear()}>
          Clear
        </Button>
        <Button size="sm" variant="outline" onClick={() => void paste()}>
          Paste
        </Button>
        <Button size="sm" variant="destructive" onClick={createNew}>
          New session
        </Button>
      </div>
      <ConfirmDialog
        open={confirmNew}
        title="New terminal session"
        message="Start a new terminal session? The current session will be killed — including all processes running inside it."
        confirmLabel="New session"
        destructive={true}
        onConfirm={confirmCreateNew}
        onCancel={() => setConfirmNew(false)}
      />
      {hint !== '' && (
        <p role="alert" className="text-sm text-yellow-400">
          {hint}
        </p>
      )}
      <div
        ref={boxRef}
        className="min-h-[400px] flex-1 rounded border border-neutral-800 bg-[#14171b]"
        onContextMenu={(ev) => {
          ev.preventDefault();
          void paste();
        }}
      />
      <div className="flex flex-wrap gap-1">
        {['esc', 'tab', '|', '/', 'pgup', 'pgdn', 'home', 'end', 'up', 'down', 'left', 'right'].map((key) => (
          <Button key={key} size="sm" variant="outline" onClick={() => pressKey(key)}>
            {key}
          </Button>
        ))}
        <Button size="sm" variant={ctrl ? 'default' : 'outline'} onClick={() => pressKey('ctrl')}>
          Ctrl
        </Button>
        <Button size="sm" variant={alt ? 'default' : 'outline'} onClick={() => pressKey('alt')}>
          Alt
        </Button>
      </div>
    </main>
  );
}

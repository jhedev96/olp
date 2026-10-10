// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from '../src/pages/login.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mounted(goto: (url: string) => void = () => {}): { root: HTMLElement; calls: string[] } {
  const calls: string[] = [];
  const root = document.createElement('div');
  document.body.append(root);
  const page = LoginPage({ goto: (url) => { calls.push(url); goto(url); } });
  page.mount(root);
  return { root, calls };
}

function fill(root: HTMLElement, user: string, pass: string): void {
  const u = root.querySelector<HTMLInputElement>('[data-user]');
  const p = root.querySelector<HTMLInputElement>('[data-pass]');
  if (u === null || p === null) throw new Error('form missing');
  u.value = user;
  p.value = pass;
}

async function clickLogin(root: HTMLElement): Promise<void> {
  root.querySelector<HTMLButtonElement>('[data-action="login"]')?.click();
  await new Promise((r) => setTimeout(r, 50));
}

describe('web login page', () => {
  it('renders the card with theme toggle', () => {
    const { root } = mounted();
    expect(root.querySelector('[data-user]')).not.toBeNull();
    expect(root.querySelector('[data-pass]')).not.toBeNull();
    expect(root.querySelector('[data-action="login"]')?.textContent).toBe('Log in');
    expect(root.textContent).toContain('OpenLocalPanel');
  });

  it('navigates on success', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(200, { ok: true })));
    const seen: string[] = [];
    const { root } = mounted((url) => {
      seen.push(url);
    });
    fill(root, 'ops', 's3cret');
    await clickLogin(root);
    expect(seen).toEqual(['/dashboard']);
    expect(root.querySelector('[data-error]')?.textContent).toBe('');
  });

  it('shows the server message on bad credentials without navigating', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(401, { error: 'Invalid username or password' })));
    const seen: string[] = [];
    const { root } = mounted((url) => {
      seen.push(url);
    });
    fill(root, 'ops', 'wrong');
    await clickLogin(root);
    expect(root.querySelector('[data-error]')?.textContent).toBe('Invalid username or password');
    expect(seen).toEqual([]);
  });

  it('shows a fallback on network failure', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('down')));
    const { root } = mounted();
    fill(root, 'ops', 'x');
    await clickLogin(root);
    expect(root.querySelector('[data-error]')?.textContent).toBe('Login failed');
  });

  it('submits on Enter and toggles theme', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(200, { ok: true })));
    const seen: string[] = [];
    const { root } = mounted((url) => {
      seen.push(url);
    });
    fill(root, 'ops', 's3cret');
    root.querySelector('[data-pass]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['/dashboard']);

    const before = document.documentElement.classList.contains('light');
    root.querySelector<HTMLButtonElement>('[data-action="theme"]')?.click();
    expect(document.documentElement.classList.contains('light')).toBe(!before);
  });
});

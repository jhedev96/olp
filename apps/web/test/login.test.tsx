// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { LoginPage } from '../src/pages/login.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.documentElement.classList.remove('light');
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('web login page (React)', () => {
  it('renders the card with theme toggle', async () => {
    await act(async () => {
      render(<LoginPage />);
    });
    expect(screen.getByPlaceholderText('Username')).not.toBeNull();
    expect(screen.getByPlaceholderText('Password')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Authenticate' })).not.toBeNull();
    expect(screen.getByText('OpenLocalPanel Gateway')).not.toBeNull();
  });

  it('shows honest placeholders when stats are unreachable pre-auth', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(401, { error: 'Unauthorized' })));
    await act(async () => {
      render(<LoginPage goto={() => {}} />);
    });
    expect(screen.getByText('load —')).not.toBeNull();
    expect(screen.getByText('Air-gapped LAN listener active')).not.toBeNull();
    expect(screen.getByText('Salted PBKDF2 120k')).not.toBeNull();
  });

  it('clears fields and parks passkey without browser support', async () => {
    await act(async () => {
      render(<LoginPage />);
    });
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'ops' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Clear username'));
    });
    expect((screen.getByPlaceholderText('Username') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Hardware passkey' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Local pipe auth' })).toHaveProperty('disabled', false);
  });

  it('navigates on success', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(200, { ok: true })));
    const seen: string[] = [];
    await act(async () => {
      render(<LoginPage goto={(url) => seen.push(url)} />);
    });
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 's3cret' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }));
    });
    expect(seen).toEqual(['/dashboard']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('posts the remember flag when checked', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
      return Promise.resolve(jsonResponse(200, { ok: true }));
    });
    await act(async () => {
      render(<LoginPage goto={() => undefined} />);
    });
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 's3cret' } });
    fireEvent.click(screen.getByLabelText(/Remember session/));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }));
    });
    expect(bodies.some((b) => (b as { remember?: unknown }).remember === true)).toBe(true);
  });

  it('disables passkey without browser support', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(401, { error: 'x' })));
    await act(async () => {
      render(<LoginPage />);
    });
    const button = screen.getByRole('button', { name: 'Hardware passkey' });
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('title')).toBe('Passkeys are not supported in this browser');
  });

  it('signs in with a passkey when supported', async () => {
    const calls: string[] = [];
    Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true });
    Object.defineProperty(window.navigator, 'credentials', {
      value: { get: () => Promise.resolve({ id: 'cred-1', fake: true }) },
      configurable: true,
    });
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
      if (url === '/api/auth/passkey/login/options') return Promise.resolve(jsonResponse(200, { options: { challenge: 'c' }, state: 's1' }));
      return Promise.resolve(jsonResponse(200, { ok: true }));
    });
    try {
      const seen: string[] = [];
      await act(async () => {
        render(<LoginPage goto={(url) => seen.push(url)} />);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Hardware passkey' }));
      });
      expect(seen).toEqual(['/dashboard']);
      expect(bodies.some((b) => (b as { state?: unknown }).state === 's1')).toBe(true);
    } finally {
      const nav = window.navigator as unknown as Record<string, unknown>;
      delete nav['credentials'];
      delete (window as unknown as Record<string, unknown>)['PublicKeyCredential'];
    }
  });

  it('confirms local login with the localhost warning', async () => {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      Promise.resolve(jsonResponse(200, url === '/api/login/local' && (init?.method ?? 'GET') === 'POST' ? { ok: true } : {})),
    );
    const seen: string[] = [];
    await act(async () => {
      render(<LoginPage goto={(url) => seen.push(url)} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Local pipe auth' }));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('loopback');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in locally' }));
    });
    expect(seen).toEqual(['/dashboard']);
  });

  it('shows the server message on bad credentials without navigating', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(401, { error: 'Invalid username or password' })));
    const seen: string[] = [];
    await act(async () => {
      render(<LoginPage goto={(url) => seen.push(url)} />);
    });
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'wrong' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('Invalid username or password');
    expect(seen).toEqual([]);
  });

  it('shows a fallback on network failure and toggles theme', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('down')));
    await act(async () => {
      render(<LoginPage />);
    });
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'x' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('Login failed');

    const before = document.documentElement.classList.contains('light');
    await act(async () => {
      fireEvent.click(screen.getByTitle(before ? 'Dark mode' : 'Light mode'));
    });
    expect(document.documentElement.classList.contains('light')).toBe(!before);
  });
});

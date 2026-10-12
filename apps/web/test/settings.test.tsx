// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { SettingsPage } from '../src/pages/settings.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function stubApi(handler: (url: string, method: string, body: unknown) => { status: number; json: unknown }): { calls: Array<{ url: string; method: string; body: unknown }> } {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const body = init?.body !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const { status, json } = handler(url, init?.method ?? 'GET', body);
    return Promise.resolve(new Response(JSON.stringify(json), { status }));
  });
  return { calls };
}

const SETTINGS = {
  username: 'ops',
  version: '2.0.0-alpha.1',
  telegram: { botToken: 'tok', chatId: '123', enabled: true, commandsEnabled: false },
};

const SESSIONS = {
  sessions: [
    { id: 'a1b2c3d4', browser: 'Chrome 124.0', os: 'macOS 14.4', ip: '192.168.1.104', created: 1000, lastSeen: 2000, expiresAt: Date.now() + 86400000, current: true },
    { id: 'e5f60718', browser: 'Firefox 126.0 Mobile', os: 'Android 14', ip: '192.168.1.185', created: 1500, lastSeen: 2500, expiresAt: Date.now() + 30 * 86400000, current: false },
  ],
};

const SETTINGS_BIND = {
  ...SETTINGS,
  bind: { host: '127.0.0.1', port: 8080, loopback: true },
};

function sessionsHandler(url: string): { status: number; json: unknown } {
  if (url === '/api/settings') return { status: 200, json: SETTINGS_BIND };
  if (url === '/api/auth/sessions') return { status: 200, json: SESSIONS };
  if (url === '/api/settings/telegram/identity') return { status: 200, json: { username: 'TerwoNodeBot' } };
  if (url === '/api/auth/passkeys') {
    return { status: 200, json: { passkeys: [{ id: 'cred-1', name: 'YubiKey 5', created: 1000 }] } };
  }
  if (url === '/api/auth/passkey/register/options') return { status: 200, json: { options: { challenge: 'c' }, state: 's9' } };
  if (url === '/api/auth/passkey/register/verify') return { status: 200, json: { ok: true, id: 'cred-2' } };
  return { status: 200, json: { ok: true } };
}

describe('web settings page', () => {
  it('loads username, version, and telegram state', async () => {
    stubApi((url) => (url === '/api/settings' ? { status: 200, json: SETTINGS } : { status: 200, json: { ok: true } }));
    await act(async () => {
      render(<SettingsPage />);
    });
    expect(screen.getByText('ops')).not.toBeNull();
    expect(screen.getByText(/v2\.0\.0-alpha\.1/)).not.toBeNull();
    expect((screen.getByPlaceholderText('Bot token') as HTMLInputElement).value).toBe('tok');
    expect((screen.getByPlaceholderText('Chat ID') as HTMLInputElement).value).toBe('123');
  });

  it('saves usernames and shows errors', async () => {
    const { calls } = stubApi((url) => {
      if (url === '/api/settings') return { status: 200, json: SETTINGS };
      if (url === '/api/auth/change-username') return { status: 400, json: { error: 'Username taken' } };
      return { status: 200, json: { ok: true } };
    });
    await act(async () => {
      render(<SettingsPage />);
    });
    fireEvent.change(screen.getByPlaceholderText('New username'), { target: { value: 'ops2' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save username'));
    });
    expect(screen.getByText('Username taken')).not.toBeNull();
    expect(calls.some((c) => c.url === '/api/auth/change-username' && (c.body as { username: string }).username === 'ops2')).toBe(true);
  });

  it('checks password confirmation locally, then redirects after change', async () => {
    const seen: string[] = [];
    const laters: Array<() => void> = [];
    stubApi(() => ({ status: 200, json: SETTINGS }));
    await act(async () => {
      render(<SettingsPage goto={(url) => seen.push(url)} later={(fn) => laters.push(fn)} />);
    });
    const pw = screen.getByPlaceholderText('New password') as HTMLInputElement;
    const conf = screen.getByPlaceholderText('Confirm new password') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'abcdef' } });
    fireEvent.change(conf, { target: { value: 'abcdeg' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save password'));
    });
    expect(screen.getByText('Password confirmation does not match')).not.toBeNull();

    const okStub = stubApi((url) => {
      if (url === '/api/settings') return { status: 200, json: SETTINGS };
      return { status: 200, json: { ok: true } };
    });
    fireEvent.change(conf, { target: { value: 'abcdef' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save password'));
    });
    expect(screen.getByText('Password changed — please log in again')).not.toBeNull();
    expect(okStub.calls.some((c) => c.url === '/api/auth/change-password')).toBe(true);
    laters.forEach((fn) => fn());
    expect(seen).toEqual(['/login']);
  });

  it('saves telegram and tests delivery', async () => {
    const { calls } = stubApi((url, method) => {
      if (url === '/api/settings' && method === 'GET') return { status: 200, json: SETTINGS };
      if (url === '/api/settings/test-telegram') return { status: 200, json: { ok: true } };
      return { status: 200, json: { ok: true } };
    });
    await act(async () => {
      render(<SettingsPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save telegram'));
    });
    const save = calls.find((c) => c.url === '/api/settings' && c.method === 'POST');
    expect(save?.body).toMatchObject({ telegram: { botToken: 'tok', chatId: '123', enabled: true, commandsEnabled: false } });
    await act(async () => {
      fireEvent.click(screen.getByText('Send test'));
    });
    expect(screen.getByText('Test message sent')).not.toBeNull();
  });

  it('logs out all sessions with dialog', async () => {
    const { calls } = stubApi(() => ({ status: 200, json: SETTINGS }));
    const seen: string[] = [];
    await act(async () => {
      render(<SettingsPage goto={(url) => seen.push(url)} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Log out all sessions'));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('every device');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Log out all' }));
    });
    expect(calls.some((c) => c.url === '/api/auth/logout-all')).toBe(true);
    expect(seen).toEqual(['/login']);
  });

  it('toasts saves and parks server sections as dummies', async () => {
    stubApi((url, method) =>
      url === '/api/settings' && method === 'GET'
        ? { status: 200, json: SETTINGS }
        : { status: 200, json: { ok: true } },
    );
    await act(async () => {
      render(<SettingsPage />);
    });
    fireEvent.change(screen.getByPlaceholderText('New username'), { target: { value: 'ops2' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save username'));
    });
    expect(screen.getByRole('status').textContent).toBe('Username saved');
    await act(async () => {
      fireEvent.click(screen.getByText('Save telegram'));
    });
    expect(screen.getByRole('status').textContent).toBe('Telegram saved');
    expect(screen.queryByText('CAND-030')).toBeNull();
    expect(screen.queryByText('CAND-031')).toBeNull();
    expect(screen.getByText('Bind address')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Export JSON' })).not.toBeNull();
  });

  it('meters password strength and documents daemon reload', async () => {
    stubApi(() => ({ status: 200, json: SETTINGS }));
    await act(async () => {
      render(<SettingsPage />);
    });
    fireEvent.change(screen.getByPlaceholderText('New password'), { target: { value: 'short' } });
    expect(screen.getByText('Weak')).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText('New password'), { target: { value: 'Correct horse battery 9!' } });
    expect(screen.getByText('Strong')).not.toBeNull();
    expect(screen.getByText('pm2 restart olp')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Copy command' })).not.toBeNull();
  });

  it('lists sessions with this-device badge and no self revoke', async () => {
    stubApi((url) => sessionsHandler(url));
    await act(async () => {
      render(<SettingsPage />);
    });
    expect(screen.getByText('Active device sessions')).not.toBeNull();
    expect(screen.getByText('2 connected')).not.toBeNull();
    expect(screen.getByText('Chrome 124.0')).not.toBeNull();
    expect(screen.getByText('Firefox 126.0 Mobile')).not.toBeNull();
    expect(screen.getByText('THIS DEVICE')).not.toBeNull();
    expect(screen.getAllByText('Revoke')).toHaveLength(1);
    expect(screen.getByText('Log out other sessions')).not.toBeNull();
  });

  it('shows the verified badge, bind card, and row expiry', async () => {
    stubApi((url) => sessionsHandler(url));
    await act(async () => {
      render(<SettingsPage />);
    });
    expect(screen.getByText('Verified: @TerwoNodeBot')).not.toBeNull();
    expect(screen.getByText('Bind address')).not.toBeNull();
    expect(screen.getByText('127.0.0.1:8080')).not.toBeNull();
    expect(screen.getByText('Loopback only')).not.toBeNull();
    expect(screen.getAllByText(/Expires in /)).toHaveLength(2);
    expect(screen.queryByText('CAND-031')).toBeNull();
  });

  it('falls back to unverified and LAN warning honestly', async () => {
    stubApi((url) => {
      if (url === '/api/settings') {
        return { status: 200, json: { ...SETTINGS, bind: { host: '0.0.0.0', port: 8080, loopback: false } } };
      }
      if (url === '/api/settings/telegram/identity') return { status: 200, json: { username: null } };
      if (url === '/api/auth/sessions') return { status: 200, json: { sessions: [] } };
      return { status: 200, json: { ok: true } };
    });
    await act(async () => {
      render(<SettingsPage />);
    });
    expect(screen.getByText('Unverified')).not.toBeNull();
    expect(screen.getByText('LAN exposed — do not put on the internet')).not.toBeNull();
    expect(screen.getByText('No active sessions.')).not.toBeNull();
  });

  it('lists passkeys and registers a new one', async () => {
    const { calls } = stubApi((url, method) => sessionsHandler(url));
    Object.defineProperty(window.navigator, 'credentials', {
      value: { create: () => Promise.resolve({ id: 'cred-2', fake: true }) },
      configurable: true,
    });
    try {
      await act(async () => {
        render(<SettingsPage />);
      });
      expect(screen.getByText('Passkeys')).not.toBeNull();
      expect(screen.getByText('1 registered')).not.toBeNull();
      expect(screen.getByText('YubiKey 5')).not.toBeNull();
      fireEvent.change(screen.getByLabelText('New passkey name'), { target: { value: 'Pixel 8' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Register passkey'));
      });
      const verify = calls.find((c) => c.url === '/api/auth/passkey/register/verify');
      expect(verify?.method).toBe('POST');
      expect(verify?.body).toMatchObject({ state: 's9', name: 'Pixel 8' });
    } finally {
      delete (window.navigator as unknown as Record<string, unknown>)['credentials'];
    }
  });

  it('deletes passkeys through the dialog', async () => {
    const { calls } = stubApi((url, method) => {
      if (url === '/api/auth/passkeys' && method === 'DELETE') return { status: 200, json: { ok: true } };
      return sessionsHandler(url);
    });
    await act(async () => {
      render(<SettingsPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Delete'));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('YubiKey 5');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    expect(calls.some((c) => c.url === '/api/auth/passkeys/cred-1' && c.method === 'DELETE')).toBe(true);
  });

  it('revokes a session through the dialog and reloads', async () => {
    const { calls } = stubApi((url, method) => {
      if (url === '/api/settings') return { status: 200, json: SETTINGS };
      if (url === '/api/auth/sessions' && method === 'GET') return { status: 200, json: SESSIONS };
      if (url === '/api/auth/sessions/e5f60718/revoke') return { status: 200, json: { ok: true, self: false } };
      return { status: 200, json: { ok: true } };
    });
    await act(async () => {
      render(<SettingsPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Revoke'));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Firefox 126.0 Mobile');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    });
    expect(calls.some((c) => c.url === '/api/auth/sessions/e5f60718/revoke' && c.method === 'POST')).toBe(true);
    expect(calls.filter((c) => c.url === '/api/auth/sessions').length).toBeGreaterThan(1);
  });

  it('logs out other sessions without leaving', async () => {
    const seen: string[] = [];
    const { calls } = stubApi((url, method) => {
      if (url === '/api/settings') return { status: 200, json: SETTINGS };
      if (url === '/api/auth/sessions' && method === 'GET') return { status: 200, json: SESSIONS };
      if (url === '/api/auth/sessions/others/revoke') return { status: 200, json: { ok: true, revoked: 1 } };
      if (url === '/api/auth/sessions/a1b2c3d4/revoke') return { status: 200, json: { ok: true, self: true } };
      return { status: 200, json: { ok: true } };
    });
    await act(async () => {
      render(<SettingsPage goto={(url) => seen.push(url)} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Log out other sessions'));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Log out others' }));
    });
    expect(calls.some((c) => c.url === '/api/auth/sessions/others/revoke')).toBe(true);
    expect(seen).toEqual([]);
  });
});

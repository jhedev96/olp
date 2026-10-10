// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

  it('logs out all sessions with confirm', async () => {
    const { calls } = stubApi(() => ({ status: 200, json: SETTINGS }));
    (window as unknown as Record<string, unknown>).confirm = () => true;
    const seen: string[] = [];
    await act(async () => {
      render(<SettingsPage goto={(url) => seen.push(url)} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Log out all sessions'));
    });
    expect(calls.some((c) => c.url === '/api/auth/logout-all')).toBe(true);
    expect(seen).toEqual(['/login']);
  });
});

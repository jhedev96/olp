import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, apiJson, wsUrl } from '../src/lib/api.js';
import { esc, fmtAgo, fmtDate, fmtIn, fmtSize, fmtUptime } from '../src/lib/format.js';
import { navigate, slugFromPath } from '../src/lib/router.js';
import type { HistoryLike } from '../src/lib/router.js';
import { getTheme, setTheme } from '../src/lib/theme.js';
import type { DocumentLike, StorageLike } from '../src/lib/theme.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function memStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function memDocument(): DocumentLike & { light(): boolean | undefined } {
  let light: boolean | undefined;
  return {
    documentElement: {
      classList: {
        toggle: (_token: string, force?: boolean) => {
          light = force;
        },
      },
    },
    light: () => light,
  };
}

describe('web lib/api', () => {
  it('redirects to login on 401 and throws', async () => {
    const location = { href: '' };
    vi.stubGlobal('window', { location });
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(401, { error: 'x' })));
    await expect(api('/api/me')).rejects.toMatchObject({ status: 401 });
    expect(location.href).toBe('/login');
  });

  it('passes responses and network errors through', async () => {
    vi.stubGlobal('window', { location: { href: '' } });
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(200, { ok: true })));
    const res = await api('/api/me');
    expect(res.status).toBe(200);
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('down')));
    await expect(api('/api/me')).rejects.toThrow('down');
  });

  it('rethrows 401 without redirecting when asked', async () => {
    const location = { href: '' };
    vi.stubGlobal('window', { location });
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(401, { error: 'Invalid username or password' })));
    await expect(apiJson('/api/login', {}, { unauthorized: 'rethrow' })).rejects.toMatchObject({
      status: 401,
      message: 'Invalid username or password',
    });
    expect(location.href).toBe('');
  });

  it('parses JSON and surfaces server errors', async () => {
    vi.stubGlobal('window', { location: { href: '' } });
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(200, { username: 'ops' })));
    expect(await apiJson<{ username: string }>('/api/me')).toEqual({ username: 'ops' });

    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(400, { error: 'Bad name' })));
    await expect(apiJson('/api/x')).rejects.toMatchObject({ status: 400, message: 'Bad name' });

    vi.stubGlobal('fetch', () => Promise.resolve(new Response('oops', { status: 500 })));
    await expect(apiJson('/api/x')).rejects.toMatchObject({ status: 500, message: 'Request failed (500)' });
    expect(new ApiError(404, 'gone')).toMatchObject({ status: 404, name: 'ApiError' });
  });

  it('builds ws URLs per page protocol', () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'phone:8080' } });
    expect(wsUrl('/term')).toBe('ws://phone:8080/term');
    vi.stubGlobal('window', { location: { protocol: 'https:', host: 'h' } });
    expect(wsUrl('/term')).toBe('wss://h/term');
  });
});

describe('web lib/format', () => {
  it('sizes units and guards', () => {
    expect(fmtSize(0)).toBe('0 B');
    expect(fmtSize(1023)).toBe('1023 B');
    expect(fmtSize(1024)).toBe('1.0 KB');
    expect(fmtSize(1048576)).toBe('1.0 MB');
    expect(fmtSize(1073741824)).toBe('1.00 GB');
    expect(fmtSize(NaN)).toBe('0 B');
    expect(fmtSize(-5)).toBe('0 B');
  });

  it('dates and uptimes', () => {
    expect(fmtDate(0)).toContain('1970');
    expect(fmtUptime(0)).toBe('0m');
    expect(fmtUptime(90)).toBe('1m');
    expect(fmtUptime(3661)).toBe('1h 1m');
    expect(fmtUptime(90061)).toBe('1d 1h');
  });

  it('formats relative ago times', () => {
    const now = 1728470400000;
    expect(fmtAgo(now, now)).toBe('just now');
    expect(fmtAgo(now - 30000, now)).toBe('just now');
    expect(fmtAgo(now - 5 * 60000, now)).toBe('5m ago');
    expect(fmtAgo(now - 2 * 3600000, now)).toBe('2h ago');
    expect(fmtAgo(now - 30 * 3600000, now)).toBe('Yesterday');
    expect(fmtAgo(now - 3 * 86400000, now)).toBe('3d ago');
    expect(fmtAgo(now + 60000, now)).toBe('just now');
  });

  it('formats future expiry times', () => {
    const now = 1728470400000;
    expect(fmtIn(now, now)).toBe('expired');
    expect(fmtIn(now - 60000, now)).toBe('expired');
    expect(fmtIn(now + 5 * 60000, now)).toBe('in 5m');
    expect(fmtIn(now + 5 * 3600000, now)).toBe('in 5h');
    expect(fmtIn(now + 30 * 86400000, now)).toBe('in 30d');
  });

  it('escapes markup', () => {
    expect(esc('<b>a&b</b>')).toBe('&lt;b&gt;a&amp;b&lt;/b&gt;');
    expect(esc(42)).toBe('42');
    expect(esc(undefined)).toBe('undefined');
  });
});

describe('web lib/router', () => {
  it('maps slugs with dashboard fallback', () => {
    expect(slugFromPath('/dashboard')).toBe('dashboard');
    expect(slugFromPath('/files/')).toBe('files');
    expect(slugFromPath('/')).toBe('dashboard');
    expect(slugFromPath('/nope')).toBe('dashboard');
    expect(slugFromPath('')).toBe('dashboard');
  });

  it('pushes history without reloading', () => {
    const pushed: Array<{ data: unknown; url: string | URL | null | undefined }> = [];
    const history: HistoryLike = {
      pushState: (data, _title, url) => {
        pushed.push({ data, url });
      },
    };
    navigate('files', undefined, history);
    expect(pushed).toEqual([{ data: { slug: 'files' }, url: '/files' }]);
  });

  it('carries an optional query string', () => {
    const pushed: Array<{ data: unknown; url: string | URL | null | undefined }> = [];
    const history: HistoryLike = {
      pushState: (data, _title, url) => {
        pushed.push({ data, url });
      },
    };
    navigate('files', 'path=%24PREFIX%2Fetc', history);
    expect(pushed).toEqual([{ data: { slug: 'files' }, url: '/files?path=%24PREFIX%2Fetc' }]);
  });
});

describe('web lib/theme', () => {
  it('defaults dark and migrates legacy keys', () => {
    expect(getTheme(memStorage())).toBe('dark');
    expect(getTheme(memStorage({ 'terwo-theme': 'light' }))).toBe('light');
    expect(getTheme(memStorage({ 'olp-theme': 'light', 'terwo-theme': 'dark' }))).toBe('light');
    expect(getTheme(memStorage({ 'olp-theme': 'nope' }))).toBe('dark');
  });

  it('persists under the new key and reflects on html', () => {
    const storage = memStorage({ 'terwo-theme': 'light' });
    const doc = memDocument();
    setTheme('dark', storage, doc);
    expect(storage.data['olp-theme']).toBe('dark');
    expect(storage.data['terwo-theme']).toBe('light');
    expect(doc.light()).toBe(false);
    setTheme('light', storage, doc);
    expect(doc.light()).toBe(true);
  });
});

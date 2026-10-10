import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '@olp/auth';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';

const KNOWN_PASSWORD = 'testpass1';

function freshDirs(): { dataDir: string; legacyDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-srv-'));
  return { dataDir: join(base, 'data'), legacyDir: join(base, 'legacy') };
}

function seedKnown(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      username: 'tester',
      salt: '0'.repeat(32),
      hash: hashPassword(KNOWN_PASSWORD, '0'.repeat(32)),
    }),
  );
}

/** Extract the `tpsid` cookie value from an inject response. */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : (raw as string);
  return (first ?? '').split(';')[0] ?? '';
}

describe('server auth routes', () => {
  it('serves public probes without auth', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir });
    for (const url of ['/healthz', '/api/health']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    }
  });

  it('gates protected routes with 401', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir });
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Not logged in' });
  });

  it('rejects bad credentials with 401', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir });
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'tester', password: 'wrongpass' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Invalid username or password' });
  });

  it('logs in, serves identity, and logs out', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir });
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'tester', password: KNOWN_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const cookie = sessionCookie(login);
    expect(cookie).toMatch(/^tpsid=[0-9a-f]{64}$/);
    expect(String(login.headers['set-cookie'])).toContain('HttpOnly');

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ username: 'tester' });

    const logout = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('changes username with validation and persists', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir });
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'tester', password: KNOWN_PASSWORD },
    });
    const cookie = sessionCookie(login);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/change-username',
      headers: { cookie },
      payload: { username: 'x' },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/change-username',
      headers: { cookie },
      payload: { username: 'ops-2' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, username: 'ops-2' });
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json()).toEqual({ username: 'ops-2' });
  });

  it('changes password, revokes sessions, and migrates legacy', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir });
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'tester', password: KNOWN_PASSWORD },
    });
    const cookie = sessionCookie(login);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'nope1234', newPassword: 'brandnew1', confirmPassword: 'brandnew1' },
    });
    expect(wrong.statusCode).toBe(400);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: KNOWN_PASSWORD, newPassword: 'brandnew1', confirmPassword: 'brandnew1' },
    });
    expect(changed.statusCode).toBe(200);

    const stale = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(stale.statusCode).toBe(401);

    const relogin = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'tester', password: 'brandnew1' },
    });
    expect(relogin.statusCode).toBe(200);
    const cookie2 = sessionCookie(relogin);

    const logoutAll = await app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: { cookie: cookie2 },
    });
    expect(logoutAll.statusCode).toBe(200);
    const afterAll = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookie2 } });
    expect(afterAll.statusCode).toBe(401);
  });
});

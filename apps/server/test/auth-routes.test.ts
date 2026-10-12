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

  it('tracks sessions with metadata, current flags, and touch refresh', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir });
    const CHROME =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const FIREFOX = 'Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0';
    const loginAs = (ua: string, ip: string) =>
      app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { 'user-agent': ua },
        remoteAddress: ip,
        payload: { username: 'tester', password: KNOWN_PASSWORD },
      });
    const cookieA = sessionCookie(await loginAs(CHROME, '10.1.1.1'));
    const cookieB = sessionCookie(await loginAs(FIREFOX, '10.2.2.2'));

    // List requests carry their browser's UA (like reality): touch
    // refreshes with the same identity, keeping rows stable.
    const listA = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { cookie: cookieA, 'user-agent': CHROME },
      remoteAddress: '10.1.1.1',
    });
    expect(listA.statusCode).toBe(200);
    const rows = listA.json().sessions as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ browser: 'Chrome 124.0.0.0', os: 'macOS 10.15.7', ip: '10.1.1.1', current: true });
    expect(rows[1]).toMatchObject({ browser: 'Firefox 126.0 Mobile', os: 'Android 14', ip: '10.2.2.2', current: false });
    for (const row of rows) {
      expect(row['id']).toMatch(/^[0-9a-f]{8}$/);
      expect(typeof row['created']).toBe('number');
      expect(typeof row['lastSeen']).toBe('number');
    }
    expect(JSON.stringify(rows)).not.toMatch(/[0-9a-f]{64}/);

    const listB = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { cookie: cookieB, 'user-agent': FIREFOX },
      remoteAddress: '10.2.2.2',
    });
    expect((listB.json().sessions as Array<Record<string, unknown>>).map((r) => r['current'])).toEqual([false, true]);

    // preHandler touch refreshes metadata: a new UA rewrites the caller's own row.
    await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: cookieA, 'user-agent': 'curl/8.5.0' } });
    const relisted = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { cookie: cookieB, 'user-agent': FIREFOX },
      remoteAddress: '10.2.2.2',
    });
    const mine = (relisted.json().sessions as Array<Record<string, unknown>>).find((r) => r['current'] === false);
    expect(mine).toMatchObject({ browser: 'Unknown', os: 'Unknown' });

    expect((await app.inject({ method: 'GET', url: '/api/auth/sessions' })).statusCode).toBe(401);
  });

  it('revokes by id and others with honest guards', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir });
    const loginAs = (ua: string) =>
      app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { 'user-agent': ua },
        payload: { username: 'tester', password: KNOWN_PASSWORD },
      });
    const cookieA = sessionCookie(await loginAs('TestBrowser/1.0'));
    const cookieB = sessionCookie(await loginAs('TestBrowser/2.0'));
    const rows = (
      await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: cookieA } })
    ).json().sessions as Array<{ id: string; current: boolean }>;
    const otherId = rows.find((r) => !r.current)?.id ?? '';
    const selfId = rows.find((r) => r.current)?.id ?? '';

    // Static route wins over the parametric id (never 'Unknown session' here).
    const others = await app.inject({ method: 'POST', url: '/api/auth/sessions/others/revoke', headers: { cookie: cookieA } });
    expect(others.json()).toEqual({ ok: true, revoked: 1 });
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieB } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieA } })).statusCode).toBe(200);

    const ghost = await app.inject({ method: 'POST', url: '/api/auth/sessions/deadbeef/revoke', headers: { cookie: cookieA } });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json()).toEqual({ error: 'Unknown session' });

    // Revoking the other session reports self:false and keeps our cookie.
    const cookieC = sessionCookie(await loginAs('TestBrowser/3.0'));
    const rows2 = (
      await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: cookieA } })
    ).json().sessions as Array<{ id: string; current: boolean }>;
    const freshOther = rows2.find((r) => !r.current)?.id ?? '';
    const kill = await app.inject({ method: 'POST', url: `/api/auth/sessions/${freshOther}/revoke`, headers: { cookie: cookieA } });
    expect(kill.json()).toEqual({ ok: true, self: false });
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieC } })).statusCode).toBe(401);

    // Crafted self-revoke dies honestly and clears the orphaned cookie.
    const self = await app.inject({ method: 'POST', url: `/api/auth/sessions/${selfId}/revoke`, headers: { cookie: cookieA } });
    expect(self.json()).toEqual({ ok: true, self: true });
    expect(String(self.headers['set-cookie'])).toContain('tpsid=;');
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieA } })).statusCode).toBe(401);

    expect((await app.inject({ method: 'POST', url: '/api/auth/sessions/others/revoke' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/sessions/deadbeef/revoke' })).statusCode).toBe(401);
  });
});

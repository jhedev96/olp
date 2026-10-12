import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMEMBER_TTL_MS, SESSION_TTL_MS, hashPassword } from '@olp/auth';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import type { PasskeyOps } from '../src/passkey.js';

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

function fakePasskeys(): PasskeyOps {
  const bad = (response: unknown): boolean =>
    typeof response === 'object' && response !== null && (response as Record<string, unknown>)['bad'] === true;
  return {
    registrationOptions: ({ username, rpId, excludeIds }) =>
      Promise.resolve({ options: { challenge: 'reg-chal', rpId, user: username, exclude: excludeIds }, challenge: 'reg-chal' }),
    verifyRegistration: ({ response }) =>
      bad(response)
        ? Promise.reject(new Error('bad attestation\nsecond line'))
        : Promise.resolve({ id: 'cred-1', publicKey: 'cGsx', counter: 0 }),
    authenticationOptions: ({ allowIds, rpId }) =>
      Promise.resolve({ options: { challenge: 'auth-chal', allow: allowIds, rpId }, challenge: 'auth-chal' }),
    verifyAuthentication: ({ response }) =>
      bad(response) ? Promise.reject(new Error('bad assertion')) : Promise.resolve({ counter: 7 }),
  };
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

  it('pairs 30-day cookie and session on remember-me', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir });
    const login = (payload: unknown) => app.inject({ method: 'POST', url: '/api/login', payload });

    const plain = await login({ username: 'tester', password: KNOWN_PASSWORD });
    expect(String(plain.headers['set-cookie'])).toContain('Max-Age=86400');

    const remembered = await login({ username: 'tester', password: KNOWN_PASSWORD, remember: true });
    expect(String(remembered.headers['set-cookie'])).toContain('Max-Age=2592000');
    const rememberedCookie = sessionCookie(remembered);

    const quirky = await login({ username: 'tester', password: KNOWN_PASSWORD, remember: 'yes' });
    expect(String(quirky.headers['set-cookie'])).toContain('Max-Age=86400');

    const rows = (
      await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: rememberedCookie } })
    ).json().sessions as Array<{ id: string; current: boolean; created: number; expiresAt: number }>;
    const mine = rows.find((r) => r.current);
    expect((mine?.expiresAt ?? 0) - (mine?.created ?? 0)).toBe(REMEMBER_TTL_MS);
    const plainRow = rows.find((r) => !r.current);
    expect((plainRow?.expiresAt ?? 0) - (plainRow?.created ?? 0)).toBe(SESSION_TTL_MS);
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

  it('registers, lists, and deletes passkeys with guards', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir, passkeyOps: fakePasskeys() });
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'tester', password: KNOWN_PASSWORD } });
    const cookie = sessionCookie(login);

    expect((await app.inject({ method: 'POST', url: '/api/auth/passkey/register/options' })).statusCode).toBe(401);
    const opts = await app.inject({ method: 'POST', url: '/api/auth/passkey/register/options', headers: { cookie } });
    expect(opts.statusCode).toBe(200);
    expect(opts.json().options).toMatchObject({ challenge: 'reg-chal' });
    const state = opts.json().state as string;

    const badState = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/register/verify',
      headers: { cookie },
      payload: { state: 'deadbeef', response: {} },
    });
    expect(badState.statusCode).toBe(400);
    expect(badState.json()).toEqual({ error: 'Expired or unknown ceremony' });

    const badAtt = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/register/verify',
      headers: { cookie },
      payload: { state, response: { bad: true } },
    });
    // State is single-use: a fresh ceremony is needed after the consume.
    expect(badAtt.statusCode).toBe(400);

    const opts2 = await app.inject({ method: 'POST', url: '/api/auth/passkey/register/options', headers: { cookie } });
    const badAtt2 = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/register/verify',
      headers: { cookie },
      payload: { state: opts2.json().state, response: { bad: true }, name: 'key' },
    });
    expect(badAtt2.statusCode).toBe(400);
    expect(badAtt2.json()).toEqual({ error: 'bad attestation' });

    const opts3 = await app.inject({ method: 'POST', url: '/api/auth/passkey/register/options', headers: { cookie } });
    const done = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/register/verify',
      headers: { cookie },
      payload: { state: opts3.json().state, response: { id: 'cred-1' }, name: 'my key' },
    });
    expect(done.json()).toEqual({ ok: true, id: 'cred-1' });

    const list = await app.inject({ method: 'GET', url: '/api/auth/passkeys', headers: { cookie } });
    expect(list.json().passkeys).toMatchObject([{ id: 'cred-1', name: 'my key' }]);
    expect(typeof list.json().passkeys[0].created).toBe('number');
    expect(JSON.stringify(list.json())).not.toContain('cGsx');

    const gone = await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/nope', headers: { cookie } });
    expect(gone.statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/cred-1', headers: { cookie } })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: '/api/auth/passkeys', headers: { cookie } })).json()).toEqual({ passkeys: [] });
  });

  it('logs in with passkeys publicly and guards failures', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir, passkeyOps: fakePasskeys() });

    const empty = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/options' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: 'No passkeys registered' });

    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'tester', password: KNOWN_PASSWORD } });
    const cookie = sessionCookie(login);
    const reg = await app.inject({ method: 'POST', url: '/api/auth/passkey/register/options', headers: { cookie } });
    await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/register/verify',
      headers: { cookie },
      payload: { state: reg.json().state, response: { id: 'cred-1' } },
    });

    // Login ceremony is PUBLIC (no cookie needed).
    const opts = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/options' });
    expect(opts.statusCode).toBe(200);
    expect(opts.json().options).toMatchObject({ challenge: 'auth-chal' });

    const badState = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/verify', payload: { state: 'nope', response: {} } });
    expect(badState.statusCode).toBe(400);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/login/verify',
      payload: { state: opts.json().state, response: { id: 'ghost' } },
    });
    expect(unknown.statusCode).toBe(401);

    const opts2 = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/options' });
    const failed = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/login/verify',
      payload: { state: opts2.json().state, response: { id: 'cred-1', bad: true } },
    });
    expect(failed.statusCode).toBe(401);
    expect(failed.json()).toEqual({ error: 'Passkey verification failed' });

    const opts3 = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/options' });
    const done = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/login/verify',
      payload: { state: opts3.json().state, response: { id: 'cred-1' } },
    });
    expect(done.json()).toEqual({ ok: true });
    expect(String(done.headers['set-cookie'])).toContain('Max-Age=86400');
    const session = sessionCookie(done);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: session } })).statusCode).toBe(200);
  });

  it('expires single-use ceremony states', async () => {
    const { ChallengeMap } = await import('../src/passkey.js');
    const map = new ChallengeMap();
    expect(map.take('missing', 1000)).toBeNull();
    expect(map.take(42, 1000)).toBeNull();
    const state = map.issue('chal', 1000);
    expect(map.take(state, 1000)).toBe('chal');
    expect(map.take(state, 1000)).toBeNull();
    const old = map.issue('old', 1000);
    expect(map.take(old, 1000 + 5 * 60 * 1000 + 1)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  REMEMBER_MAX_AGE,
  REMEMBER_TTL_MS,
  SESSION_TTL_MS,
  changePassword,
  changeUsername,
  clearCookie,
  generatePassword,
  generateSalt,
  generateUsername,
  hashPassword,
  loadConfig,
  loginCookie,
  parseCookies,
  parseUserAgent,
  saveConfig,
  sessionTokenFromHeader,
  timingSafeEq,
  validUsername,
  validateNewPassword,
  verifyCredentials,
  verifyPassword,
  SessionStore,
} from '../src/index.js';
import type { AuthConfig, ConfigIo } from '../src/index.js';

/** In-memory fs fake that also records write modes. */
function memIo(files: Record<string, string> = {}): ConfigIo & { modes: string[]; store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  const modes: string[] = [];
  return {
    store,
    modes,
    mkdirp: () => {},
    readFile: (f) => (f in store ? (store[f] as string) : null),
    writeFile: (f, data) => {
      store[f] = data;
      modes.push(f);
    },
  };
}

describe('password', () => {
  it('hashes deterministically and verifies', () => {
    const salt = generateSalt();
    const hash = hashPassword('s3cret!', salt);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPassword('s3cret!', salt, hash)).toBe(true);
    expect(verifyPassword('wrong', salt, hash)).toBe(false);
    expect(verifyPassword('s3cret!', generateSalt(), hash)).toBe(false);
  });

  it('rejects empty passwords and hashes', () => {
    expect(verifyPassword('', 'salt', 'hash')).toBe(false);
    expect(verifyPassword(undefined, 'salt', 'hash')).toBe(false);
    expect(verifyPassword('x', 'salt', '')).toBe(false);
  });

  it('compares timing-safe with length guard', () => {
    expect(timingSafeEq('admin', 'admin')).toBe(true);
    expect(timingSafeEq('admin', 'rootx')).toBe(false);
    expect(timingSafeEq('admin', 'administrator')).toBe(false);
  });

  it('generates well-formed credentials', () => {
    expect(generateSalt()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateUsername()).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/);
    expect(generatePassword().length).toBeGreaterThan(10);
  });

  it('validates usernames', () => {
    expect(validUsername('abc')).toBe(true);
    expect(validUsername('a-b_c123')).toBe(true);
    expect(validUsername('ab')).toBe(false);
    expect(validUsername('x'.repeat(33))).toBe(false);
    expect(validUsername('has space')).toBe(false);
    expect(validUsername('')).toBe(false);
    expect(validUsername(42)).toBe(false);
  });

  it('validates new passwords', () => {
    expect(validateNewPassword('12345', '12345')).toBe('New password must be at least 6 characters');
    expect(validateNewPassword('123456', '654321')).toBe('Password confirmation does not match');
    expect(validateNewPassword('123456', '123456')).toBeNull();
    expect(validateNewPassword('123456')).toBeNull();
  });
});

describe('config', () => {
  const cfg: AuthConfig = { username: 'admin', salt: 's'.repeat(32), hash: hashPassword('pw12345', 's'.repeat(32)), passkeys: [] };

  it('loads an existing config', () => {
    const io = memIo({ '/d/config.json': JSON.stringify(cfg) });
    const res = loadConfig('/d', { io });
    expect(res).toMatchObject({ created: false, migrated: false });
    expect(res.config).toEqual(cfg);
    expect(res.plaintextPassword).toBeUndefined();
  });

  it('defaults missing username to admin (legacy quirk)', () => {
    const io = memIo({ '/d/config.json': JSON.stringify({ salt: 's', hash: 'h' }) });
    expect(loadConfig('/d', { io }).config.username).toBe('admin');
  });

  it('rejects corrupt salt/hash', () => {
    const io = memIo({ '/d/config.json': JSON.stringify({ username: 'a' }) });
    expect(() => loadConfig('/d', { io })).toThrow(/Invalid auth config/);
  });

  it('migrates legacy bytes verbatim with owner-only write', () => {
    const legacy = JSON.stringify(cfg);
    const io = memIo({ '/old/config.json': legacy });
    const res = loadConfig('/new', { legacyDir: '/old', io });
    expect(res.migrated).toBe(true);
    expect(res.config).toEqual(cfg);
    expect(io.store['/new/config.json']).toBe(legacy);
    expect(io.modes).toContain('/new/config.json');
  });

  it('tolerates old files without passkeys and drops garbage rows', () => {
    const bare = loadConfig('/d', { io: memIo({ '/d/config.json': JSON.stringify({ username: 'a', salt: 's', hash: 'h' }) }) });
    expect(bare.config.passkeys).toEqual([]);
    const messy = loadConfig(
      '/d',
      {
        io: memIo({
          '/d/config.json': JSON.stringify({
            username: 'a',
            salt: 's',
            hash: 'h',
            passkeys: [
              { id: 'k1', publicKey: 'pk1', counter: 3, name: 'key', created: 9 },
              { id: '', publicKey: 'pk' },
              { id: 'k2' },
              'junk',
              null,
            ],
          }),
        }),
      },
    );
    expect(messy.config.passkeys).toEqual([{ id: 'k1', publicKey: 'pk1', counter: 3, name: 'key', created: 9 }]);
  });

  it('round-trips passkeys and preserves them across password change', () => {
    const withKey: AuthConfig = {
      ...cfg,
      passkeys: [{ id: 'k1', publicKey: 'pk1', counter: 0, name: 'key', created: 1 }],
    };
    const io = memIo({});
    saveConfig('/d', withKey, io);
    expect(loadConfig('/d', { io }).config.passkeys).toEqual(withKey.passkeys);
    const changed = changePassword(withKey, 'pw12345', 'newpass99', 'newpass99');
    expect('config' in changed && changed.config.passkeys).toEqual(withKey.passkeys);
  });

  it('generates first-run credentials with one-time plaintext', () => {
    const io = memIo();
    const res = loadConfig('/d', { io });
    expect(res.created).toBe(true);
    expect(res.plaintextPassword).toBeTypeOf('string');
    expect(verifyPassword(res.plaintextPassword as string, res.config.salt, res.config.hash)).toBe(true);
    expect(io.store['/d/config.json']).not.toContain(res.plaintextPassword as string);
  });

  it('saves with owner-only write', () => {
    const io = memIo();
    saveConfig('/d', cfg, io);
    expect(JSON.parse(io.store['/d/config.json'] as string)).toEqual(cfg);
    expect(io.modes).toContain('/d/config.json');
  });

  it('verifies credentials', () => {
    expect(verifyCredentials('admin', 'pw12345', cfg)).toBe(true);
    expect(verifyCredentials('root', 'pw12345', cfg)).toBe(false);
    expect(verifyCredentials('admin', 'nope123', cfg)).toBe(false);
    expect(verifyCredentials('admin', '', cfg)).toBe(false);
  });

  it('changes username with validation', () => {
    expect(changeUsername(cfg, 'ops-2').config?.username).toBe('ops-2');
    expect(changeUsername(cfg, 'x').error).toMatch(/3-32/);
  });

  it('changes password with fresh salt', () => {
    expect(changePassword(cfg, 'bad', 'newpass1', 'newpass1').error).toBe('Current password is incorrect');
    expect(changePassword(cfg, 'pw12345', 'short', 'short').error).toMatch(/6 characters/);
    expect(changePassword(cfg, 'pw12345', 'newpass1', 'other').error).toMatch(/does not match/);
    const ok = changePassword(cfg, 'pw12345', 'newpass1', 'newpass1');
    expect('config' in ok && ok.config.salt).not.toBe(cfg.salt);
    if ('config' in ok) {
      expect(verifyPassword('newpass1', ok.config.salt, ok.config.hash)).toBe(true);
      expect(verifyPassword('pw12345', ok.config.salt, ok.config.hash)).toBe(false);
    }
  });
});

describe('sessions', () => {
  const META = { browser: 'Chrome 124.0', os: 'macOS 14.4', ip: '192.168.1.104' };

  it('creates unique hex tokens and validates', () => {
    const store = new SessionStore();
    const a = store.create(META, { now: 1000 });
    const b = store.create(META, { now: 1000 });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(store.validate(a, 1000)).toBe(true);
    expect(store.validate('missing', 1000)).toBe(false);
    expect(store.validate(42, 1000)).toBe(false);
    expect(store.size).toBe(2);
  });

  it('expires absolutely with lazy delete', () => {
    const store = new SessionStore();
    const t = store.create(META, { now: 1000 });
    expect(store.validate(t, 1000 + SESSION_TTL_MS)).toBe(true);
    expect(store.validate(t, 1000 + SESSION_TTL_MS + 1)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('prunes, revokes, and clears', () => {
    const store = new SessionStore();
    const a = store.create(META, { now: 1000 });
    store.create(META, { now: 1000 });
    store.create(META, { now: 5000 });
    expect(store.prune(1000 + SESSION_TTL_MS + 1)).toBe(2);
    expect(store.size).toBe(1);
    store.revoke(a);
    expect(store.size).toBe(1);
    store.revokeAll();
    expect(store.size).toBe(0);
  });

  it('lists live sessions with ids, flags, and no tokens', () => {
    const store = new SessionStore();
    const a = store.create(META, { now: 1000 });
    const b = store.create({ ...META, ip: '192.168.1.185' }, { now: 2000 });
    const rows = store.list(a, 3000);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ browser: 'Chrome 124.0', ip: '192.168.1.104', created: 1000, lastSeen: 1000, current: true });
    expect(rows[1]).toMatchObject({ ip: '192.168.1.185', current: false });
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{8}$/);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
    // Tokens never serialize (scan the whole payload for 64-hex secrets).
    const dumped = JSON.stringify(rows);
    expect(dumped).not.toContain(a);
    expect(dumped).not.toContain(b);
    expect(dumped).not.toMatch(/[0-9a-f]{64}/);
  });

  it('touches last-seen metadata and drops dead tokens', () => {
    const store = new SessionStore();
    const a = store.create(META, { now: 1000 });
    expect(store.touch(a, { ...META, ip: '10.0.0.9' }, 9000)).toBe(true);
    expect(store.list(a, 9000)[0]).toMatchObject({ lastSeen: 9000, ip: '10.0.0.9' });
    expect(store.touch('missing', META, 9000)).toBe(false);
    expect(store.touch(42, META, 9000)).toBe(false);
    expect(store.touch(a, META, 1000 + SESSION_TTL_MS + 1)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('revokes by id with self detection and others with counts', () => {
    const store = new SessionStore();
    const a = store.create(META, { now: 1000 });
    store.create(META, { now: 1000 });
    const ids = store.list(null, 1000).map((r) => r.id);
    expect(store.revokeById('deadbeef', a, 1000)).toBeNull();
    expect(store.revokeById(ids[1] ?? '', a, 1000)).toEqual({ revoked: true, self: false });
    expect(store.size).toBe(1);
    expect(store.revokeById(ids[0] ?? '', a, 1000)).toEqual({ revoked: true, self: true });
    expect(store.size).toBe(0);
  });

  it('revokes others keeping the caller', () => {
    const store = new SessionStore();
    const a = store.create(META, { now: 1000 });
    store.create(META, { now: 1000 });
    store.create(META, { now: 1000 });
    expect(store.revokeOthers(a, 2000)).toBe(2);
    expect(store.list(a, 2000)).toHaveLength(1);
    expect(store.revokeOthers('ghost', 2000)).toBe(1);
    expect(store.size).toBe(0);
  });

  it('honors per-session TTL with paired expiry', () => {
    const store = new SessionStore();
    const day = store.create(META, { now: 1000 });
    const month = store.create(META, { ttlMs: REMEMBER_TTL_MS, now: 1000 });
    expect(store.list(day, 1000)[0]).toMatchObject({ expiresAt: 1000 + SESSION_TTL_MS });
    expect(store.list(month, 1000)[1]).toMatchObject({ expiresAt: 1000 + REMEMBER_TTL_MS });
    // The default session dies at 24h while the remembered one survives.
    expect(store.validate(day, 1000 + SESSION_TTL_MS + 1)).toBe(false);
    expect(store.validate(month, 1000 + SESSION_TTL_MS + 1)).toBe(true);
    expect(store.validate(month, 1000 + REMEMBER_TTL_MS)).toBe(true);
    expect(store.validate(month, 1000 + REMEMBER_TTL_MS + 1)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('prunes mixed lifetimes independently', () => {
    const store = new SessionStore();
    store.create(META, { now: 1000 });
    store.create(META, { ttlMs: REMEMBER_TTL_MS, now: 1000 });
    expect(store.prune(1000 + SESSION_TTL_MS + 1)).toBe(1);
    expect(store.size).toBe(1);
  });
});

describe('user-agent parser', () => {
  it('parses flagship browsers and systems', () => {
    expect(
      parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.119 Safari/537.36'),
    ).toEqual({ browser: 'Chrome 124.0.6367.119', os: 'macOS 10.15.7' });
    expect(
      parseUserAgent('Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0'),
    ).toEqual({ browser: 'Firefox 126.0 Mobile', os: 'Android 14' });
    expect(
      parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'),
    ).toEqual({ browser: 'Safari 17.4 Mobile', os: 'iOS 17.4' });
    expect(
      parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.80'),
    ).toEqual({ browser: 'Edge 124.0.2478.80', os: 'Windows 10.0' });
  });

  it('answers Unknown for empty and garbage input', () => {
    expect(parseUserAgent('')).toEqual({ browser: 'Unknown', os: 'Unknown' });
    expect(parseUserAgent('curl/8.5.0')).toEqual({ browser: 'Unknown', os: 'Unknown' });
    expect(parseUserAgent('(((not a ua)))')).toEqual({ browser: 'Unknown', os: 'Unknown' });
  });
});

describe('cookies', () => {
  it('parses headers and skips malformed entries', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('tpsid=abc123; theme=dark')).toEqual({ tpsid: 'abc123', theme: 'dark' });
    expect(parseCookies('a=%zz; tpsid=ok')).toEqual({ tpsid: 'ok' });
    expect(parseCookies('nonsense')).toEqual({});
  });

  it('serializes flags byte-identical to Terwo', () => {
    expect(loginCookie('TOKEN')).toBe('tpsid=TOKEN; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400');
    expect(loginCookie('TOKEN', REMEMBER_MAX_AGE)).toBe('tpsid=TOKEN; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000');
    expect(clearCookie()).toBe('tpsid=; HttpOnly; Path=/; Max-Age=0');
  });

  it('extracts the session token', () => {
    expect(sessionTokenFromHeader('tpsid=abc; x=1')).toBe('abc');
    expect(sessionTokenFromHeader('x=1')).toBeUndefined();
  });
});

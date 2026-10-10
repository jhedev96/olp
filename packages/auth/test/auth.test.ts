import { describe, expect, it } from 'vitest';
import {
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
  const cfg: AuthConfig = { username: 'admin', salt: 's'.repeat(32), hash: hashPassword('pw12345', 's'.repeat(32)) };

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
  it('creates unique hex tokens and validates', () => {
    const store = new SessionStore();
    const a = store.create(1000);
    const b = store.create(1000);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(store.validate(a, 1000)).toBe(true);
    expect(store.validate('missing', 1000)).toBe(false);
    expect(store.validate(42, 1000)).toBe(false);
    expect(store.size).toBe(2);
  });

  it('expires absolutely with lazy delete', () => {
    const store = new SessionStore();
    const t = store.create(1000);
    expect(store.validate(t, 1000 + SESSION_TTL_MS)).toBe(true);
    expect(store.validate(t, 1000 + SESSION_TTL_MS + 1)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('prunes, revokes, and clears', () => {
    const store = new SessionStore();
    const a = store.create(1000);
    store.create(1000);
    store.create(5000);
    expect(store.prune(1000 + SESSION_TTL_MS + 1)).toBe(2);
    expect(store.size).toBe(1);
    store.revoke(a);
    expect(store.size).toBe(1);
    store.revokeAll();
    expect(store.size).toBe(0);
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
    expect(clearCookie()).toBe('tpsid=; HttpOnly; Path=/; Max-Age=0');
  });

  it('extracts the session token', () => {
    expect(sessionTokenFromHeader('tpsid=abc; x=1')).toBe('abc');
    expect(sessionTokenFromHeader('x=1')).toBeUndefined();
  });
});

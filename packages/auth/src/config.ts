import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  generatePassword,
  generateSalt,
  generateUsername,
  hashPassword,
  timingSafeEq,
  validUsername,
  validateNewPassword,
  verifyPassword,
} from './password.js';

/** Persisted admin credential record (`config.json`). */
export interface AuthConfig {
  username: string;
  salt: string;
  hash: string;
  /** Registered passkeys (public-key material only; absent on old files → `[]`). */
  passkeys: PasskeyCredential[];
}

/** One registered WebAuthn credential (no secrets — id + public key + counter). */
export interface PasskeyCredential {
  /** Credential id (base64url, client-opaque). */
  id: string;
  /** COSE public key (base64url). */
  publicKey: string;
  /** Signature counter (clone detection via the lib). */
  counter: number;
  /** Human label from registration. */
  name: string;
  created: number;
}

/** Tolerant passkey list parse (garbage rows drop, absent → `[]`). */
function normalizePasskeys(raw: unknown): PasskeyCredential[] {
  if (!Array.isArray(raw)) return [];
  const out: PasskeyCredential[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || r['id'] === '') continue;
    if (typeof r['publicKey'] !== 'string' || r['publicKey'] === '') continue;
    out.push({
      id: r['id'],
      publicKey: r['publicKey'],
      counter: typeof r['counter'] === 'number' ? r['counter'] : 0,
      name: typeof r['name'] === 'string' ? r['name'] : '',
      created: typeof r['created'] === 'number' ? r['created'] : 0,
    });
  }
  return out;
}

/** Injectable filesystem surface (tests use fakes; production uses `node:fs`). */
export interface ConfigIo {
  mkdirp?: (dir: string) => void;
  readFile?: (file: string) => string | null;
  writeFile?: (file: string, data: string) => void;
}

/** Result of {@link loadConfig}. */
export interface LoadResult {
  config: AuthConfig;
  /** True when fresh credentials were generated (first run). */
  created: boolean;
  /** True when copied from the legacy Terwo directory. */
  migrated: boolean;
  /** Plaintext password, present ONLY on first-run generation (display once). */
  plaintextPassword?: string;
}

const CONFIG_FILENAME = 'config.json';
/** Config files are owner-only (matches Terwo `0600`). */
const CONFIG_MODE = 0o600;

function defaultIo(): Required<ConfigIo> {
  return {
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    readFile: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    writeFile: (file, data) => fs.writeFileSync(file, data, { mode: CONFIG_MODE }),
  };
}

/**
 * Normalize a parsed `config.json` body.
 * Legacy quirk preserved: a missing `username` defaults to `'admin'`.
 *
 * @throws When `salt`/`hash` are absent (corrupt config fails closed).
 */
function normalize(raw: unknown): AuthConfig {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const username = typeof obj['username'] === 'string' && obj['username'] !== '' ? obj['username'] : 'admin';
  const salt = obj['salt'];
  const hash = obj['hash'];
  if (typeof salt !== 'string' || salt === '' || typeof hash !== 'string' || hash === '') {
    throw new Error('Invalid auth config (missing salt/hash)');
  }
  return { username, salt, hash, passkeys: normalizePasskeys(obj['passkeys']) };
}

/**
 * Shape-validate unknown JSON into credentials (bundle-restore
 * guard: corrupt backups must fail before any overwrite).
 * Same rules as {@link loadConfig} without touching the fs.
 *
 * @throws When `salt`/`hash` are absent (fails closed).
 */
export function parseAuthConfig(raw: unknown): AuthConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid auth config (missing salt/hash)');
  return normalize(raw);
}

/**
 * Load credentials from `dataDir`, migrating from `legacyDir`
 * (`~/.termux-panel`) or generating first-run credentials when absent.
 */
export function loadConfig(
  dataDir: string,
  opts: { legacyDir?: string; io?: ConfigIo } = {},
): LoadResult {
  const io = { ...defaultIo(), ...(opts.io ?? {}) };
  io.mkdirp(dataDir);
  const file = path.join(dataDir, CONFIG_FILENAME);
  const raw = io.readFile(file);
  if (raw !== null) return { config: normalize(JSON.parse(raw)), created: false, migrated: false };
  if (opts.legacyDir !== undefined) {
    const legacyRaw = io.readFile(path.join(opts.legacyDir, CONFIG_FILENAME));
    if (legacyRaw !== null) {
      io.writeFile(file, legacyRaw);
      return { config: normalize(JSON.parse(legacyRaw)), created: false, migrated: true };
    }
  }
  const username = generateUsername();
  const password = generatePassword();
  const salt = generateSalt();
  const config: AuthConfig = { username, salt, hash: hashPassword(password, salt), passkeys: [] };
  io.writeFile(file, JSON.stringify(config, null, 2));
  return { config, created: true, migrated: false, plaintextPassword: password };
}

/** Persist credentials (always mode `0600`). */
export function saveConfig(dataDir: string, config: AuthConfig, io?: ConfigIo): void {
  const writer = io?.writeFile ?? defaultIo().writeFile;
  writer(path.join(dataDir, CONFIG_FILENAME), JSON.stringify(config, null, 2));
}

/**
 * Verify login credentials: timing-safe username compare plus
 * password re-hash compare (Terwo parity, generic failure).
 */
export function verifyCredentials(username: unknown, password: unknown, config: AuthConfig): boolean {
  const userOk = timingSafeEq(typeof username === 'string' ? username : '', config.username);
  const passOk = verifyPassword(password, config.salt, config.hash);
  return userOk && passOk;
}

/**
 * Change the admin username. Sessions stay valid (Terwo parity);
 * the caller persists via {@link saveConfig}.
 */
export function changeUsername(
  config: AuthConfig,
  username: unknown,
): { config: AuthConfig } | { error: string } {
  if (!validUsername(username)) {
    return { error: 'Username must be 3-32 characters (letters/numbers/_/-)' };
  }
  return { config: { ...config, username } };
}

/**
 * Change the admin password. Returns a new config with a fresh salt;
 * the caller must {@link saveConfig} and revoke all sessions
 * (forces re-login everywhere, Terwo parity).
 */
export function changePassword(
  config: AuthConfig,
  current: unknown,
  next: unknown,
  confirm: unknown,
): { config: AuthConfig } | { error: string } {
  if (!verifyPassword(current, config.salt, config.hash)) {
    return { error: 'Current password is incorrect' };
  }
  const invalid = validateNewPassword(next, confirm);
  if (invalid !== null) return { error: invalid };
  const salt = generateSalt();
  return {
    // Spread preserves passkeys (a password change must never wipe keys).
    config: { ...config, salt, hash: hashPassword(next as string, salt) },
  };
}

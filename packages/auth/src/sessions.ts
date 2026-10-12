import { randomBytes } from 'node:crypto';

/** Session lifetime: 24h absolute from creation (Terwo parity, no sliding). */
export const SESSION_TTL_MS = 86400 * 1000;

/** Remembered session lifetime: 30 days (login checkbox opt-in). */
export const REMEMBER_TTL_MS = 30 * 86400 * 1000;

/** Public session id size (8 random hex chars; tokens stay 64-hex secrets). */
const PUBLIC_ID_BYTES = 4;

/** Parsed client metadata captured at login and refreshed per request. */
export interface SessionMeta {
  browser: string;
  os: string;
  ip: string;
}

/** List row shape (tokens never serialize — only the public id). */
export interface SessionInfo extends SessionMeta {
  id: string;
  created: number;
  lastSeen: number;
  /** Absolute expiry (`created + ttlMs`); honored by every method. */
  expiresAt: number;
  current: boolean;
}

/** Creation options (TTL pairs with the cookie `Max-Age` — drift is a bug). */
export interface CreateOptions {
  ttlMs?: number;
  now?: number;
}

interface Session extends SessionMeta {
  created: number;
  lastSeen: number;
  expiresAt: number;
  publicId: string;
}

/**
 * In-memory admin session store.
 *
 * Single-admin by design: sessions die on restart (forces re-login).
 * Metadata is parsed-only (raw User-Agents never stored) and
 * memory-only (no persistence). The server owns the hourly `prune()`
 * timer; this class never starts timers itself.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  /** Number of live (unpruned) entries. */
  get size(): number {
    return this.sessions.size;
  }

  private freshId(): string {
    const taken = new Set<string>();
    for (const session of this.sessions.values()) taken.add(session.publicId);
    let id = '';
    do {
      id = randomBytes(PUBLIC_ID_BYTES).toString('hex');
    } while (taken.has(id));
    return id;
  }

  private live(token: unknown, now: number): { token: string; session: Session } | null {
    if (typeof token !== 'string' || token === '') return null;
    const session = this.sessions.get(token);
    if (session === undefined) return null;
    if (now > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return { token, session };
  }

  /** Create a session, returning its 32-byte hex token. */
  create(meta: SessionMeta, options: CreateOptions = {}): string {
    const now = options.now ?? Date.now();
    const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { ...meta, created: now, lastSeen: now, expiresAt: now + ttlMs, publicId: this.freshId() });
    return token;
  }

  /**
   * Validate a token. Expired tokens are lazy-deleted and report `false`.
   * Non-string tokens report `false` (never throws).
   */
  validate(token: unknown, now: number = Date.now()): boolean {
    return this.live(token, now) !== null;
  }

  /**
   * Refresh a session's last-seen metadata (login UA/IP evolve:
   * network or browser switches show last-seen truth, not stale
   * creation data). Dead or absent tokens report `false` (never
   * throws, no throw paths by construction).
   */
  touch(token: unknown, meta: SessionMeta, now: number = Date.now()): boolean {
    const found = this.live(token, now);
    if (found === null) return false;
    found.session.lastSeen = now;
    found.session.browser = meta.browser;
    found.session.os = meta.os;
    found.session.ip = meta.ip;
    return true;
  }

  /**
   * List live sessions in creation order, flagging the caller's own
   * token as `current`. Expired entries prune first so dead rows
   * never render. Tokens never serialize (public ids only).
   */
  list(currentToken: unknown = null, now: number = Date.now()): SessionInfo[] {
    this.prune(now);
    const out: SessionInfo[] = [];
    for (const [token, session] of this.sessions) {
      out.push({
        id: session.publicId,
        browser: session.browser,
        os: session.os,
        ip: session.ip,
        created: session.created,
        lastSeen: session.lastSeen,
        expiresAt: session.expiresAt,
        current: token === currentToken,
      });
    }
    return out;
  }

  /**
   * Revoke one session by public id. Unknown ids answer `null`;
   * otherwise `{revoked: true, self}` (`self` when the revoked
   * session is the caller's own — the endpoint clears its cookie).
   */
  revokeById(id: string, currentToken: unknown = null, now: number = Date.now()): { revoked: boolean; self: boolean } | null {
    this.prune(now);
    for (const [token, session] of this.sessions) {
      if (session.publicId !== id) continue;
      this.sessions.delete(token);
      return { revoked: true, self: token === currentToken };
    }
    return null;
  }

  /**
   * Revoke every live session except the caller's own.
   *
   * @returns Number of sessions revoked.
   */
  revokeOthers(currentToken: unknown, now: number = Date.now()): number {
    this.prune(now);
    let removed = 0;
    for (const [token] of this.sessions) {
      if (token === currentToken) continue;
      this.sessions.delete(token);
      removed++;
    }
    return removed;
  }

  /** Revoke one token (no-op when absent). */
  revoke(token: unknown): void {
    if (typeof token === 'string') this.sessions.delete(token);
  }

  /** Revoke everything (password change, logout-all). */
  revokeAll(): void {
    this.sessions.clear();
  }

  /**
   * Drop expired entries.
   *
   * @returns Number of removed sessions.
   */
  prune(now: number = Date.now()): number {
    let removed = 0;
    for (const [token, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(token);
        removed++;
      }
    }
    return removed;
  }
}

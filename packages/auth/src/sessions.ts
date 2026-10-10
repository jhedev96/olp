import { randomBytes } from 'node:crypto';

/** Session lifetime: 24h absolute from creation (Terwo parity, no sliding). */
export const SESSION_TTL_MS = 86400 * 1000;

interface Session {
  created: number;
}

/**
 * In-memory admin session store.
 *
 * Single-admin by design: sessions die on restart (forces re-login).
 * The server owns the hourly `prune()` timer; this class never
 * starts timers itself.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  /** Number of live (unpruned) entries. */
  get size(): number {
    return this.sessions.size;
  }

  /** Create a session, returning its 32-byte hex token. */
  create(now: number = Date.now()): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { created: now });
    return token;
  }

  /**
   * Validate a token. Expired tokens are lazy-deleted and report `false`.
   * Non-string tokens report `false` (never throws).
   */
  validate(token: unknown, now: number = Date.now()): boolean {
    if (typeof token !== 'string' || token === '') return false;
    const session = this.sessions.get(token);
    if (session === undefined) return false;
    if (now - session.created > SESSION_TTL_MS) {
      this.sessions.delete(token);
      return false;
    }
    return true;
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
      if (now - session.created > SESSION_TTL_MS) {
        this.sessions.delete(token);
        removed++;
      }
    }
    return removed;
  }
}

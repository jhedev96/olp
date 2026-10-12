import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  SessionStore,
  changePassword,
  changeUsername,
  clearCookie,
  loginCookie,
  loadConfig,
  parseUserAgent,
  saveConfig,
  sessionTokenFromHeader,
  verifyCredentials,
} from '@olp/auth';
import type { AuthConfig, SessionMeta } from '@olp/auth';

/** Resolved credential directories. */
export interface ServerDirs {
  dataDir: string;
  legacyDir: string;
}

/**
 * Resolve credential directories. `OLP_DATA_DIR` overrides the data dir
 * (tests, containers); the legacy Terwo dir is always `~/.termux-panel`.
 */
export function resolveDirs(): ServerDirs {
  const home = homedir();
  return {
    dataDir: process.env['OLP_DATA_DIR'] ?? join(home, '.olp'),
    legacyDir: join(home, '.termux-panel'),
  };
}

/** Mutable auth state owned by the server process. */
export interface AuthContext {
  config: AuthConfig;
  store: SessionStore;
  dataDir: string;
  created: boolean;
  plaintextPassword?: string;
}

/**
 * Load (or generate/migrate) credentials and create the session store.
 * Pure besides `loadConfig` file I/O.
 */
export function createAuthContext(dataDir: string, legacyDir: string): AuthContext {
  const loaded = loadConfig(dataDir, { legacyDir });
  return {
    config: loaded.config,
    store: new SessionStore(),
    dataDir,
    created: loaded.created,
    plaintextPassword: loaded.plaintextPassword,
  };
}

/** Paths that bypass the session gate (probes + login). */
function isPublicRoute(path: string, method: string): boolean {
  if (path === '/healthz') return true;
  if (method === 'GET' && path === '/api/health') return true;
  if (method === 'POST' && path === '/api/login') return true;
  return false;
}

function requestPath(url: string): string {
  return url.split('?')[0] ?? '';
}

/**
 * Parsed client metadata for the sessions table. The raw User-Agent
 * is parsed at the boundary and dropped (never stored); the IP is
 * the direct peer (`req.ip` — `X-Forwarded-For` is never trusted,
 * no proxy sits in front of the panel).
 */
function requestMeta(req: Pick<FastifyRequest, 'headers' | 'ip'>): SessionMeta {
  const header = req.headers['user-agent'];
  const parsed = parseUserAgent(typeof header === 'string' ? header : '');
  return { browser: parsed.browser, os: parsed.os, ip: req.ip };
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

interface ChangeUsernameBody {
  username?: unknown;
}

interface ChangePasswordBody {
  currentPassword?: unknown;
  newPassword?: unknown;
  confirmPassword?: unknown;
}

/**
 * Register the session gate plus login/logout/account routes.
 * Validation failures surface as 400 `{error}` (Terwo parity);
 * bad credentials as 401.
 */
export function registerAuthRoutes(app: FastifyInstance, ctx: AuthContext): void {
  app.addHook('preHandler', async (req, reply) => {
    const path = requestPath(req.url);
    if (isPublicRoute(path, req.method)) return;
    if (!path.startsWith('/api/')) return;
    const token = sessionTokenFromHeader(req.headers.cookie);
    if (!ctx.store.validate(token)) {
      reply.code(401);
      await reply.send({ error: 'Not logged in' });
      return;
    }
    // Refresh last-seen metadata on every authed request (in-memory
    // Map write, negligible for a single admin; never throws).
    ctx.store.touch(token, requestMeta(req));
  });

  app.post('/api/login', { bodyLimit: 1048576 }, async (req, reply) => {
    const body = (req.body ?? {}) as LoginBody;
    if (!verifyCredentials(body.username, body.password, ctx.config)) {
      reply.code(401);
      return { error: 'Invalid username or password' };
    }
    reply.header('Set-Cookie', loginCookie(ctx.store.create(requestMeta(req))));
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    ctx.store.revoke(sessionTokenFromHeader(req.headers.cookie));
    reply.header('Set-Cookie', clearCookie());
    return { ok: true };
  });

  app.get('/api/me', async () => ({ username: ctx.config.username }));

  app.post('/api/auth/change-username', { bodyLimit: 1048576 }, async (req, reply) => {
    const body = (req.body ?? {}) as ChangeUsernameBody;
    const result = changeUsername(ctx.config, body.username);
    if ('error' in result) {
      reply.code(400);
      return { error: result.error };
    }
    ctx.config = result.config;
    saveConfig(ctx.dataDir, ctx.config);
    return { ok: true, username: ctx.config.username };
  });

  app.post('/api/auth/change-password', { bodyLimit: 1048576 }, async (req, reply) => {
    const body = (req.body ?? {}) as ChangePasswordBody;
    const result = changePassword(ctx.config, body.currentPassword, body.newPassword, body.confirmPassword);
    if ('error' in result) {
      reply.code(400);
      return { error: result.error };
    }
    ctx.config = result.config;
    saveConfig(ctx.dataDir, ctx.config);
    ctx.store.revokeAll();
    return { ok: true };
  });

  app.post('/api/auth/logout-all', async () => {
    ctx.store.revokeAll();
    return { ok: true };
  });

  app.get('/api/auth/sessions', async (req) => ({
    sessions: ctx.store.list(sessionTokenFromHeader(req.headers.cookie)),
  }));

  // Static before parametric (store-wave lesson): manager-style ops
  // must never collide with `:id` (plus a test proving it).
  app.post('/api/auth/sessions/others/revoke', async (req) => ({
    ok: true,
    revoked: ctx.store.revokeOthers(sessionTokenFromHeader(req.headers.cookie)),
  }));

  app.post('/api/auth/sessions/:id/revoke', async (req, reply) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    const token = sessionTokenFromHeader(req.headers.cookie);
    const result = ctx.store.revokeById(id, token);
    if (result === null) {
      reply.code(404);
      return { error: 'Unknown session' };
    }
    // Crafted self-revoke stays honest: the session dies and the
    // orphaned cookie is cleared so the client lands on login.
    if (result.self) reply.header('Set-Cookie', clearCookie());
    return { ok: true, self: result.self };
  });
}

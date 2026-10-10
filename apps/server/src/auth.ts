import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  SessionStore,
  changePassword,
  changeUsername,
  clearCookie,
  loadConfig,
  loginCookie,
  saveConfig,
  sessionTokenFromHeader,
  verifyCredentials,
} from '@olp/auth';
import type { AuthConfig } from '@olp/auth';

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
    if (!ctx.store.validate(sessionTokenFromHeader(req.headers.cookie))) {
      reply.code(401);
      await reply.send({ error: 'Not logged in' });
    }
  });

  app.post('/api/login', { bodyLimit: 1048576 }, async (req, reply) => {
    const body = (req.body ?? {}) as LoginBody;
    if (!verifyCredentials(body.username, body.password, ctx.config)) {
      reply.code(401);
      return { error: 'Invalid username or password' };
    }
    reply.header('Set-Cookie', loginCookie(ctx.store.create()));
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
}

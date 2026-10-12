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
import type { AuthConfig, PasskeyCredential, SessionMeta } from '@olp/auth';
import { REMEMBER_MAX_AGE, REMEMBER_TTL_MS } from '@olp/auth';
import { ChallengeMap, nodePasskeyOps } from './passkey.js';
import type { PasskeyOps } from './passkey.js';

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
  /** WebAuthn ceremony adapter (fake in tests — no authenticator in CI). */
  passkeys: PasskeyOps;
  /** Pending-ceremony challenges (memory-only, like sessions). */
  challenges: ChallengeMap;
}

/**
 * Load (or generate/migrate) credentials and create the session store.
 * Pure besides `loadConfig` file I/O.
 */
export function createAuthContext(
  dataDir: string,
  legacyDir: string,
  opts: { passkeyOps?: PasskeyOps } = {},
): AuthContext {
  const loaded = loadConfig(dataDir, { legacyDir });
  return {
    config: loaded.config,
    store: new SessionStore(),
    dataDir,
    created: loaded.created,
    plaintextPassword: loaded.plaintextPassword,
    passkeys: opts.passkeyOps ?? nodePasskeyOps(),
    challenges: new ChallengeMap(),
  };
}

/** Paths that bypass the session gate (probes + login). */
function isPublicRoute(path: string, method: string): boolean {
  if (path === '/healthz') return true;
  if (method === 'GET' && path === '/api/health') return true;
  if (method === 'POST' && path === '/api/login') return true;
  // Passkey login ceremony is public by design (it MINTS sessions);
  // registration stays gated (only authed users enroll keys).
  if (method === 'POST' && (path === '/api/auth/passkey/login/options' || path === '/api/auth/passkey/login/verify')) {
    return true;
  }
  // Local login mints sessions too (loopback-gated inside the handler).
  if (method === 'POST' && path === '/api/login/local') return true;
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
  remember?: unknown;
}

interface ChangeUsernameBody {
  username?: unknown;
}

interface ChangePasswordBody {
  currentPassword?: unknown;
  newPassword?: unknown;
  confirmPassword?: unknown;
}

/** Error text cap for ceremony failures (lib messages stay readable, never full dumps). */
const CEREMONY_ERROR_MAX = 200;

function ceremonyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const first = message.split('\n')[0] ?? '';
  return first === '' ? 'Passkey ceremony failed' : first.slice(0, CEREMONY_ERROR_MAX);
}

/** Loopback peers (direct socket only — proxy headers never trusted). */
export function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** RP identity from the request (no proxy in front — direct values only). */
function rpOf(req: Pick<FastifyRequest, 'hostname' | 'protocol'>): { rpId: string; origin: string } {
  const rpId = req.hostname;
  return { rpId, origin: `${req.protocol}://${rpId}` };
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
    // Remember-me pairs both sides (cookie age + session TTL) —
    // one without the other is a bug by definition.
    const remember = body.remember === true;
    const token = ctx.store.create(requestMeta(req), remember ? { ttlMs: REMEMBER_TTL_MS } : undefined);
    reply.header('Set-Cookie', loginCookie(token, remember ? REMEMBER_MAX_AGE : undefined));
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

  app.post('/api/auth/passkey/register/options', async (req) => {
    const { rpId } = rpOf(req);
    const { options, challenge } = await ctx.passkeys.registrationOptions({
      username: ctx.config.username,
      rpId,
      excludeIds: ctx.config.passkeys.map((k) => k.id),
    });
    return { options, state: ctx.challenges.issue(challenge) };
  });

  app.post('/api/auth/passkey/register/verify', { bodyLimit: 1048576 }, async (req, reply) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const challenge = ctx.challenges.take(typeof body['state'] === 'string' ? body['state'] : '');
    if (challenge === null) {
      reply.code(400);
      return { error: 'Expired or unknown ceremony' };
    }
    const { rpId, origin } = rpOf(req);
    try {
      const verified = await ctx.passkeys.verifyRegistration({
        response: body['response'],
        challenge,
        origin,
        rpId,
      });
      const name = typeof body['name'] === 'string' ? body['name'].trim().slice(0, 40) : '';
      const row: PasskeyCredential = {
        id: verified.id,
        publicKey: verified.publicKey,
        counter: verified.counter,
        name,
        created: Date.now(),
      };
      const existing = ctx.config.passkeys.findIndex((k) => k.id === row.id);
      if (existing === -1) ctx.config.passkeys.push(row);
      else ctx.config.passkeys[existing] = row;
      saveConfig(ctx.dataDir, ctx.config);
      return { ok: true, id: row.id };
    } catch (err) {
      reply.code(400);
      return { error: ceremonyError(err) };
    }
  });

  app.get('/api/auth/passkeys', async () => ({
    passkeys: ctx.config.passkeys.map((k) => ({ id: k.id, name: k.name, created: k.created })),
  }));

  app.delete('/api/auth/passkeys/:id', async (req, reply) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    const index = ctx.config.passkeys.findIndex((k) => k.id === id);
    if (index === -1) {
      reply.code(404);
      return { error: 'Unknown passkey' };
    }
    ctx.config.passkeys.splice(index, 1);
    saveConfig(ctx.dataDir, ctx.config);
    return { ok: true };
  });

  app.post('/api/auth/passkey/login/options', { bodyLimit: 1048576 }, async (req, reply) => {
    if (ctx.config.passkeys.length === 0) {
      reply.code(400);
      return { error: 'No passkeys registered' };
    }
    const { rpId } = rpOf(req);
    const { options, challenge } = await ctx.passkeys.authenticationOptions({
      allowIds: ctx.config.passkeys.map((k) => k.id),
      rpId,
    });
    return { options, state: ctx.challenges.issue(challenge) };
  });

  app.post('/api/auth/passkey/login/verify', { bodyLimit: 1048576 }, async (req, reply) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const challenge = ctx.challenges.take(typeof body['state'] === 'string' ? body['state'] : '');
    if (challenge === null) {
      reply.code(400);
      return { error: 'Expired or unknown ceremony' };
    }
    const response = body['response'];
    const responseId = typeof response === 'object' && response !== null
      ? (response as Record<string, unknown>)['id']
      : undefined;
    const credential = ctx.config.passkeys.find((k) => k.id === responseId);
    if (credential === undefined) {
      reply.code(401);
      return { error: 'Unknown credential' };
    }
    const { rpId, origin } = rpOf(req);
    try {
      const { counter } = await ctx.passkeys.verifyAuthentication({
        response,
        challenge,
        origin,
        rpId,
        credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter },
      });
      credential.counter = counter;
      saveConfig(ctx.dataDir, ctx.config);
    } catch {
      reply.code(401);
      return { error: 'Passkey verification failed' };
    }
    // Passkey sessions are always 24h (remember-me stays a password-login feature).
    reply.header('Set-Cookie', loginCookie(ctx.store.create(requestMeta(req))));
    return { ok: true };
  });

  app.post('/api/login/local', { bodyLimit: 1024 }, async (req, reply) => {
    // Strict loopback on the DIRECT socket peer (`req.ip` ignores
    // `X-Forwarded-For` by default — forged headers change nothing).
    // ACCEPTED RESIDUAL (spec §10): any localhost process, including
    // other phone apps, can use this. LAN URLs fail closed here.
    if (!isLoopback(req.ip)) {
      reply.code(403);
      return { error: 'Local login is only available from this machine (loopback)' };
    }
    const meta = requestMeta(req);
    reply.header('Set-Cookie', loginCookie(ctx.store.create({ ...meta, browser: 'Local login' })));
    return { ok: true };
  });
}

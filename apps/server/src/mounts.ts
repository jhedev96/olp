import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Environment } from '@olp/env-core';

/** One probed root (stat-only, never created or written). */
export interface MountProbe {
  path: string;
  present: boolean;
  dir: boolean;
}

/** Inputs for {@link registerMountsRoutes}. */
export interface MountsOptions {
  env: Environment;
  /** File-manager jail (always listed). */
  root: string;
  /** OS home dir (listed when different from root; Termux storage hangs off it). */
  home: string;
}

/**
 * Candidate roots for `env` (pure, no fs). The jail root is always
 * first; Termux adds its storage link targets; other envs add
 * `$HOME` when it differs. Android grant state is NOT queried (no
 * bridge) — `present` reflects fs visibility only.
 */
export function mountCandidates(env: Environment, root: string, home: string): string[] {
  const out = [root];
  if (env.id === 'termux') {
    out.push(join(home, 'storage'), '/storage/emulated/0');
  } else if (home !== '' && home !== root) {
    out.push(home);
  }
  return [...new Set(out)];
}

/** Stat each candidate (absent → honest `{present: false}`). */
export async function probeMounts(paths: string[]): Promise<MountProbe[]> {
  const out: MountProbe[] = [];
  for (const path of paths) {
    try {
      const st = await stat(path);
      out.push({ path, present: true, dir: st.isDirectory() });
    } catch {
      out.push({ path, present: false, dir: false });
    }
  }
  return out;
}

/** Register the mounts endpoint (behind the session gate like all `/api/*`). */
export function registerMountsRoutes(app: FastifyInstance, opts: MountsOptions): void {
  app.get('/api/mounts', async () => ({
    mounts: await probeMounts(mountCandidates(opts.env, opts.root, opts.home)),
  }));
}

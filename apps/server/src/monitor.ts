import { readFileSync } from 'node:fs';
import type { Environment } from '@olp/env-core';
import type { SysDeps } from '@olp/sysinfo';
import { createMonitorSampler, decideKill, sampleProcesses, sampleSummary } from '@olp/sysinfo';
import type { KillDeps, KillSignal, KillVerdict, MonitorSampler } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';

/** Inputs for {@link registerMonitorRoutes}. */
export interface MonitorOptions {
  env: Environment;
  deps: SysDeps;
  /** Directory the disk probe measures (file-manager root). */
  root: string;
  /** Kill deps override (tests pass fakes; production wires `process.*`). */
  kill?: KillDeps;
  /** Shared sampler (defaults to an isolated one — sites share it in production). */
  sampler?: MonitorSampler;
}

/** Real uid of a pid via `/proc` (null when unreadable). */
function procUid(pid: number): number | null {
  try {
    const match = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^Uid:\s*(\d+)/m);
    return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
  } catch {
    return null;
  }
}

/** Production kill deps (the only `process.*` touchpoint for kill). */
function productionKillDeps(): KillDeps {
  return {
    selfPid: () => process.pid,
    selfUid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
    targetUid: procUid,
    sendSignal: (pid, signal) => process.kill(pid, signal === 'KILL' ? 'SIGKILL' : 'SIGTERM'),
  };
}

function killStatus(verdict: KillVerdict): number {
  if (verdict.ok) return 200;
  switch (verdict.reason) {
    case 'bad-pid':
      return 400;
    case 'denied-self':
    case 'denied-init':
    case 'denied-owner':
    case 'denied-os':
      return 403;
    case 'gone':
      return 404;
    case 'failed':
      return 500;
  }
}

/**
 * Register the monitor endpoints (wave 1, read-only). The sampler lives
 * in this closure (per server instance, injected deps — never a module
 * global), so CPU/rate fields resolve from the second poll on. Both
 * routes sit behind the session gate (registered after auth routes).
 * Process kill is deliberately absent (deferred authz-designed wave).
 */
export function registerMonitorRoutes(app: FastifyInstance, opts: MonitorOptions): void {
  const sampler = opts.sampler ?? createMonitorSampler();
  const killDeps = opts.kill ?? productionKillDeps();

  app.get('/api/monitor/summary', async () => sampleSummary(opts.env, opts.deps, sampler, opts.root));

  app.get('/api/monitor/processes', async (req) => {
    const raw = (req.query as { limit?: unknown } | undefined)?.limit;
    const limit = typeof raw === 'string' ? Number.parseInt(raw, 10) : 25;
    return sampleProcesses(opts.deps, sampler, Number.isInteger(limit) ? limit : 25);
  });

  app.post('/api/monitor/processes/:pid/kill', async (req, reply) => {
    const pid = Number.parseInt((req.params as { pid?: unknown }).pid as string, 10);
    const signal = ((req.body as { signal?: unknown } | undefined)?.signal ?? 'TERM') as string;
    if (signal !== 'TERM' && signal !== 'KILL') {
      reply.code(400);
      return { error: 'Signal must be TERM or KILL' };
    }
    const verdict = decideKill(killDeps, pid, signal as KillSignal);
    console.log(`monitor kill pid=${pid} signal=${signal} ok=${verdict.ok ? 'allow' : verdict.reason}`);
    reply.code(killStatus(verdict));
    if (verdict.ok) return { ok: true, pid: verdict.pid, signal: verdict.signal };
    const messages: Record<string, string> = {
      'bad-pid': 'Invalid process id',
      'denied-self': 'Refusing to kill the panel itself',
      'denied-init': 'Refusing to kill init',
      'denied-owner': 'Not permitted for processes owned by another user',
      gone: 'Process is already gone',
      'denied-os': 'Operating system refused the signal',
      failed: 'Failed to signal the process',
    };
    return { error: messages[verdict.reason] ?? 'Failed to signal the process' };
  });
}

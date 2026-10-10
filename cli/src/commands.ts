import { detectInit, olpServiceDef, serviceController } from '@olp/services';
import type { InitSystem } from '@olp/services';
import type { ParsedArgs } from './args.js';
import { usageText } from './args.js';

/** Host facts (callers probe; pure otherwise). */
export interface CliEnv {
  platform: string;
  isTermux: boolean;
  hasSystemd: boolean;
  hasOpenrc: boolean;
  prefix: string;
  home: string;
  nodeBin: string;
}

/** Install inputs (flags with CLI defaults applied). */
export interface PlanInputs {
  host: string;
  port: number;
  user: string;
  entry: string;
  dataDir: string;
}

/** Printable install plan (no side effects — the `--dry-run` surface). */
export interface InstallPlan {
  manager: InitSystem;
  writes: Array<{ path: string; content: string; mode: number }>;
  commands: string[];
}

/** Injected side effects (memory fakes in tests). */
export interface CliIo {
  writeFile(path: string, data: string, opts?: { mode?: number }): void;
  exec(cmd: string, timeoutMs: number): Promise<string>;
  sleep(ms: number): Promise<void>;
  log(text: string): void;
}

/** Restart grace between stop and start (1 s). */
const RESTART_GRACE_MS = 1000;

/**
 * Build the install plan without touching the system. Throws an
 * actionable error when no init system is detected.
 */
export function planInstall(env: CliEnv, inputs: PlanInputs): InstallPlan {
  const manager = detectInit({
    platform: env.platform,
    isTermux: env.isTermux,
    hasSystemd: env.hasSystemd,
    hasOpenrc: env.hasOpenrc,
  });
  if (manager === 'none') {
    throw new Error('No supported init system detected (systemd, OpenRC, launchd, or Termux pm2)');
  }
  const def = olpServiceDef(manager, {
    nodeBin: env.nodeBin,
    entry: inputs.entry,
    dataDir: inputs.dataDir,
    host: inputs.host,
    port: inputs.port,
    user: inputs.user,
  });
  return {
    manager,
    writes: [{ path: def.path, content: def.content, mode: 0o644 }],
    commands: [...def.enable],
  };
}

function tail(text: string): string {
  return text.slice(-500);
}

/** Log tail for failures (house parity with service control). */
function errText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return tail(message);
}

/**
 * Run one CLI command. Returns the process exit code (0 ok, 1 runtime
 * failure, 2 usage) — the bin entry maps it to `process.exitCode`
 * without the library ever exiting (testable).
 */
export async function runCommand(
  args: ParsedArgs,
  env: CliEnv,
  io: CliIo,
  inputs: PlanInputs,
): Promise<number> {
  if (args.command === 'help') {
    io.log(usageText());
    return 0;
  }

  if (args.command === 'install') {
    let plan: InstallPlan;
    try {
      plan = planInstall(env, inputs);
    } catch (err) {
      io.log(`Error: ${errText(err)}`);
      return 1;
    }
    for (const write of plan.writes) io.log(`write ${write.path} (${write.content.length} bytes)`);
    for (const cmd of plan.commands) io.log(`run ${cmd}`);
    if (args.dryRun) return 0;
    try {
      for (const write of plan.writes) io.writeFile(write.path, write.content, { mode: write.mode });
      for (const cmd of plan.commands) await io.exec(cmd, 30000);
    } catch (err) {
      io.log(`Error: ${errText(err)}`);
      return 1;
    }
    io.log(`Installed for ${plan.manager}.`);
    return 0;
  }

  const manager = detectInit({
    platform: env.platform,
    isTermux: env.isTermux,
    hasSystemd: env.hasSystemd,
    hasOpenrc: env.hasOpenrc,
  });
  if (manager === 'none') {
    io.log('Error: No supported init system detected (systemd, OpenRC, launchd, or Termux pm2)');
    return 1;
  }
  const ctl = serviceController(manager, (cmd, timeoutMs) => io.exec(cmd, timeoutMs));

  if (args.command === 'status') {
    const active = await ctl.isActive('olp').catch(() => false);
    io.log(`olp: ${active ? 'active' : 'inactive'} (${manager})`);
    return active ? 0 : 1;
  }

  if (args.command === 'logs') {
    const viewers: Record<string, string> = {
      systemd: 'journalctl -u olp -n 100 --no-pager',
      openrc: 'tail -n 100 /var/log/olp.log',
      launchd: 'log show --predicate \'process == "node"\' --last 10m',
      pm2: 'pm2 logs olp --lines 100 --nostream',
    };
    const viewer = viewers[manager] as string;
    try {
      io.log(await io.exec(viewer, 15000));
    } catch {
      io.log(`No logs available for ${manager} (is the service installed?).`);
    }
    return 0;
  }

  if (args.command === 'stop' || args.command === 'restart') {
    try {
      await ctl.stop('olp');
    } catch (err) {
      io.log(`Error: ${errText(err)}`);
      return 1;
    }
    if (args.command === 'stop') {
      io.log('Stopped.');
      return 0;
    }
    await io.sleep(RESTART_GRACE_MS);
  }
  try {
    await ctl.start('olp');
  } catch (err) {
    io.log(`Error: ${errText(err)}`);
    return 1;
  }
  io.log('Started.');
  return 0;
}

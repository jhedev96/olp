import { describe, expect, it } from 'vitest';
import { parseArgs, usageText } from '../src/args.js';
import type { ParsedArgs } from '../src/args.js';
import { planInstall, runCommand } from '../src/commands.js';
import type { CliEnv, CliIo, PlanInputs } from '../src/commands.js';

const ENV: CliEnv = {
  platform: 'linux',
  isTermux: false,
  hasSystemd: true,
  hasOpenrc: false,
  prefix: '',
  home: '/home/ops',
  nodeBin: '/usr/bin/node',
};

const INPUTS: PlanInputs = {
  host: '127.0.0.1',
  port: 8080,
  user: 'ops',
  entry: '/opt/olp/dist/index.js',
  dataDir: '/home/ops/.olp',
};

function memoryIo(): CliIo & { files: Map<string, string>; commands: string[]; logs: string[]; sleeps: number[] } {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  return {
    files,
    commands,
    logs,
    sleeps,
    writeFile: (path, data) => {
      files.set(path, data);
    },
    exec: (cmd) => {
      commands.push(cmd);
      return Promise.resolve('');
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    log: (text) => {
      logs.push(text);
    },
  };
}

function args(command: ParsedArgs['command'], dryRun = false): ParsedArgs {
  return { command, host: '127.0.0.1', port: 8080, user: 'ops', entry: INPUTS.entry, dataDir: INPUTS.dataDir, dryRun };
}

describe('cli args', () => {
  it('parses commands, flags, and defaults', () => {
    expect(parseArgs([])).toMatchObject({ ok: true });
    expect(parseArgs(['--help'])).toMatchObject({ ok: true, args: { command: 'help' } });
    expect(parseArgs(['status'])).toMatchObject({ ok: true, args: { command: 'status', host: '127.0.0.1', port: 8080 } });
    const full = parseArgs(['install', '--host', '0.0.0.0', '--port', '9000', '--user', 'ops', '--dry-run']);
    expect(full).toMatchObject({
      ok: true,
      args: { command: 'install', host: '0.0.0.0', port: 9000, user: 'ops', dryRun: true },
    });
  });

  it('rejects usage errors with exit-2 shapes', () => {
    expect(parseArgs(['nope'])).toEqual({ ok: false, error: 'Unknown command: nope' });
    expect(parseArgs(['--nope'])).toEqual({ ok: false, error: 'Unknown flag: --nope' });
    expect(parseArgs(['install', '--port'])).toEqual({ ok: false, error: 'Flag --port needs a value' });
    expect(parseArgs(['install', '--port', 'abc'])).toEqual({ ok: false, error: 'Invalid port: abc' });
    expect(parseArgs(['install', '--port', '0'])).toEqual({ ok: false, error: 'Invalid port: 0' });
    expect(parseArgs(['status', 'extra'])).toEqual({ ok: false, error: 'Unexpected argument: extra' });
    expect(usageText()).toContain('olp <command>');
  });
});

describe('cli plan', () => {
  it('builds per-manager plans without side effects', () => {
    const plan = planInstall(ENV, INPUTS);
    expect(plan.manager).toBe('systemd');
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]?.path).toBe('/etc/systemd/system/olp.service');
    expect(plan.writes[0]?.mode).toBe(0o644);
    expect(plan.commands).toContain('systemctl enable --now olp');

    const termux = planInstall({ ...ENV, isTermux: true, prefix: '/data/data/com.termux/files/usr' }, INPUTS);
    expect(termux.manager).toBe('pm2');
    expect(termux.writes[0]?.path).toBe('/home/ops/.olp/ecosystem.config.js');
  });

  it('refuses unknown init systems actionably', () => {
    expect(() => planInstall({ ...ENV, hasSystemd: false }, INPUTS)).toThrow(/No supported init system/);
  });
});

describe('cli run', () => {
  it('dries install runs and executes for real', async () => {
    const dry = memoryIo();
    expect(await runCommand(args('install', true), ENV, dry, INPUTS)).toBe(0);
    expect(dry.files.size).toBe(0);
    expect(dry.commands).toHaveLength(0);
    expect(dry.logs.join('\n')).toContain('write /etc/systemd/system/olp.service');

    const real = memoryIo();
    expect(await runCommand(args('install'), ENV, real, INPUTS)).toBe(0);
    expect(real.files.has('/etc/systemd/system/olp.service')).toBe(true);
    expect(real.commands).toEqual(['systemctl daemon-reload', 'systemctl enable --now olp']);
    expect(real.logs.at(-1)).toBe('Installed for systemd.');
  });

  it('reports status and exit codes', async () => {
    const on = memoryIo();
    let active = true;
    const ctl = { ...on, exec: () => (active ? Promise.resolve('') : Promise.reject(new Error('inactive'))) };
    expect(await runCommand(args('status'), ENV, ctl, INPUTS)).toBe(0);
    expect(ctl.logs.at(-1)).toBe('olp: active (systemd)');
    active = false;
    const off = memoryIo();
    const ctlOff = { ...off, exec: () => Promise.reject(new Error('inactive')) };
    expect(await runCommand(args('status'), ENV, ctlOff, INPUTS)).toBe(1);
    expect(ctlOff.logs.at(-1)).toBe('olp: inactive (systemd)');
  });

  it('stops, restarts with grace, and starts', async () => {
    const io = memoryIo();
    expect(await runCommand(args('stop'), ENV, io, INPUTS)).toBe(0);
    expect(io.commands).toEqual(['systemctl stop olp']);
    expect(io.logs.at(-1)).toBe('Stopped.');

    const io2 = memoryIo();
    expect(await runCommand(args('restart'), ENV, io2, INPUTS)).toBe(0);
    expect(io2.commands).toEqual(['systemctl stop olp', 'systemctl start olp']);
    expect(io2.sleeps).toEqual([1000]);
    expect(io2.logs.at(-1)).toBe('Started.');
  });

  it('fails failed starts with tails', async () => {
    const io = memoryIo();
    const ctl = { ...io, exec: () => Promise.reject(new Error('x'.repeat(900))) };
    expect(await runCommand(args('start'), ENV, ctl, INPUTS)).toBe(1);
    expect(ctl.logs.at(-1)).toBe(`Error: Failed to start olp: ${'x'.repeat(500)}`);
  });

  it('shows logs per manager with fallback hint', async () => {
    const io = memoryIo();
    const ctl = { ...io, exec: () => Promise.resolve('Oct 10 olp[1]: up\n') };
    expect(await runCommand(args('logs'), ENV, ctl, INPUTS)).toBe(0);
    expect(ctl.logs.at(-1)).toContain('up');

    const io2 = memoryIo();
    const ctl2 = { ...io2, exec: () => Promise.reject(new Error('no journal')) };
    expect(await runCommand(args('logs'), ENV, ctl2, INPUTS)).toBe(0);
    expect(ctl2.logs.at(-1)).toContain('No logs available for systemd');
  });

  it('rejects the none manager actionably', async () => {
    const io = memoryIo();
    const bare = { ...ENV, hasSystemd: false };
    expect(await runCommand(args('status'), bare, io, INPUTS)).toBe(1);
    expect(io.logs.at(-1)).toContain('No supported init system');
  });
});

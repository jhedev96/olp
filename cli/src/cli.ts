#!/usr/bin/env node
/**
 * `olp` binary entry (thin: parse argv → run → exit code).
 * All logic lives in `args.ts`/`commands.ts` (testable without exiting).
 */
import { exec } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, usageText } from './args.js';
import { runCommand } from './commands.js';
import type { CliEnv, CliIo } from './commands.js';

/** Default server entry next to a checkout (`cli/dist` → `apps/server/dist`). */
export function defaultEntry(fromUrl: string = import.meta.url): string {
  return join(dirname(fileURLToPath(fromUrl)), '..', '..', 'apps', 'server', 'dist', 'index.js');
}

function realIo(): CliIo {
  return {
    writeFile: (path, data, opts = {}) => writeFileSync(path, data, { mode: opts.mode ?? 0o666 }),
    exec: (cmd, timeoutMs) =>
      new Promise<string>((resolve, reject) => {
        exec(cmd, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err !== null) reject(err);
          else resolve(stdout);
        });
      }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // eslint-disable-next-line no-console
    log: (text) => console.log(text),
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), { user: process.env['USER'] ?? '' });
  if (!parsed.ok) {
    // eslint-disable-next-line no-console
    console.log(`Error: ${parsed.error}\n\n${usageText()}`);
    process.exitCode = 2;
    return;
  }
  const home = homedir();
  const env: CliEnv = {
    platform: process.platform,
    isTermux: (process.env['PREFIX'] ?? '').includes('com.termux'),
    hasSystemd: existsSync('/run/systemd/system'),
    hasOpenrc: existsSync('/sbin/openrc-run'),
    prefix: process.env['PREFIX'] ?? '',
    home,
    nodeBin: process.execPath,
  };
  const code = await runCommand(
    parsed.args,
    env,
    realIo(),
    {
      host: parsed.args.host,
      port: parsed.args.port,
      user: parsed.args.user,
      entry: parsed.args.entry === '' ? defaultEntry() : parsed.args.entry,
      dataDir: parsed.args.dataDir === '' ? join(home, '.olp') : parsed.args.dataDir,
    },
  );
  process.exitCode = code;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

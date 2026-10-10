/**
 * Minimal argument parser (six commands — a framework would be
 * over-dependency). Pure and fully unit-tested.
 */

export type ParsedCommand = 'install' | 'start' | 'stop' | 'restart' | 'status' | 'logs' | 'help';

export interface ParsedArgs {
  command: ParsedCommand;
  host: string;
  port: number;
  user: string;
  entry: string;
  dataDir: string;
  dryRun: boolean;
}

export interface ParseDefaults {
  user?: string;
  entry?: string;
  dataDir?: string;
}

const COMMANDS: readonly string[] = ['install', 'start', 'stop', 'restart', 'status', 'logs', 'help'];

/**
 * Parse CLI argv (without the node/script prefix).
 * Unknown commands/flags and missing values return an error (exit 2).
 */
export function parseArgs(
  argv: string[],
  defaults: ParseDefaults = {},
): { ok: true; args: ParsedArgs } | { ok: false; error: string } {
  let command: string | undefined;
  let host = '127.0.0.1';
  let port = 8080;
  let user = defaults.user ?? '';
  let entry = defaults.entry ?? '';
  let dataDir = defaults.dataDir ?? '';
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--help' || arg === '-h') return { ok: true, args: { command: 'help', host, port, user, entry, dataDir, dryRun } };
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--host' || arg === '--port' || arg === '--user' || arg === '--entry' || arg === '--data-dir') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: `Flag ${arg} needs a value` };
      }
      i++;
      if (arg === '--host') host = value;
      else if (arg === '--port') {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
          return { ok: false, error: `Invalid port: ${value}` };
        }
        port = parsed;
      } else if (arg === '--user') user = value;
      else if (arg === '--entry') entry = value;
      else dataDir = value;
      continue;
    }
    if (arg.startsWith('--')) return { ok: false, error: `Unknown flag: ${arg}` };
    if (command !== undefined) return { ok: false, error: `Unexpected argument: ${arg}` };
    command = arg;
  }

  if (command === undefined) return { ok: true, args: { command: 'help', host, port, user, entry, dataDir, dryRun } };
  if (!COMMANDS.includes(command)) return { ok: false, error: `Unknown command: ${command}` };
  return { ok: true, args: { command: command as ParsedCommand, host, port, user, entry, dataDir, dryRun } };
}

/** Usage text (printed for `--help` and usage errors). */
export function usageText(): string {
  return [
    'Usage: olp <command> [options]',
    '',
    'Commands: install, start, stop, restart, status, logs',
    '',
    'Options:',
    '  --host <addr>     bind address (default 127.0.0.1)',
    '  --port <n>        bind port (default 8080)',
    '  --user <name>     service user (unit files)',
    '  --entry <path>    absolute server entry (dist/index.js)',
    '  --data-dir <path> data directory (default ~/.olp)',
    '  --dry-run         print the install plan without changing anything',
    '  -h, --help        show this help',
  ].join('\n');
}

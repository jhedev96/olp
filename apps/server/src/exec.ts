import { exec } from 'node:child_process';

/** Shell runner: resolves stdout, rejects `Error` on failure/timeout. */
export type ExecFn = (cmd: string, timeoutMs: number) => Promise<string>;

/**
 * Single-quote a shell argument (legacy Terwo `sq()` semantics).
 * Use for every interpolated path in shell commands.
 */
export function quoteSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Default runner over `child_process.exec` with timeout
 * and a 1 MB stdout cap.
 */
export function defaultExec(cmd: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err !== null) reject(err);
      else resolve(stdout);
    });
  });
}

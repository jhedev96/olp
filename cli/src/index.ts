/**
 * `@olp/cli` public entry (library surface for installers).
 * The `olp` binary lives in `cli.ts` (thin wrapper over this).
 */

export { parseArgs, usageText } from './args.js';
export type { ParsedArgs, ParsedCommand, ParseDefaults } from './args.js';
export { planInstall, runCommand } from './commands.js';
export type { CliCommand, CliEnv, CliIo, InstallPlan, PlanInputs } from './commands.js';
export { defaultEntry } from './cli.js';

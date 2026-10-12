import type { Plugin } from 'prettier';

/**
 * Parser for one extension family (spike-verified, ADR-006).
 * Plugins load lazily per call so the Prettier chunk stays out of
 * the initial bundle (dynamic `import()` → separate Vite chunk).
 */
export interface FormatPlan {
  parser: 'babel' | 'typescript' | 'json' | 'css' | 'html' | 'markdown' | 'yaml';
}

type Loader = () => Promise<Plugin[]>;

async function babelPlugins(): Promise<Plugin[]> {
  const [babel, estree] = await Promise.all([import('prettier/plugins/babel'), import('prettier/plugins/estree')]);
  return [babel as unknown as Plugin, estree as unknown as Plugin];
}

async function typescriptPlugins(): Promise<Plugin[]> {
  const [typescript, estree] = await Promise.all([
    import('prettier/plugins/typescript'),
    import('prettier/plugins/estree'),
  ]);
  return [typescript as unknown as Plugin, estree as unknown as Plugin];
}

async function singlePlugin(path: 'postcss' | 'html' | 'markdown' | 'yaml'): Promise<Plugin[]> {
  const plugin = await import(`prettier/plugins/${path}`);
  return [plugin as unknown as Plugin];
}

/** Extension → parser + lazy plugins (Prettier core set; else `null`). */
const TABLE = new Map<string, { parser: FormatPlan['parser']; load: Loader }>([
  ['js', { parser: 'babel', load: babelPlugins }],
  ['jsx', { parser: 'babel', load: babelPlugins }],
  ['mjs', { parser: 'babel', load: babelPlugins }],
  ['cjs', { parser: 'babel', load: babelPlugins }],
  ['ts', { parser: 'typescript', load: typescriptPlugins }],
  ['tsx', { parser: 'typescript', load: typescriptPlugins }],
  ['json', { parser: 'json', load: babelPlugins }],
  ['css', { parser: 'css', load: () => singlePlugin('postcss') }],
  ['html', { parser: 'html', load: () => singlePlugin('html') }],
  ['htm', { parser: 'html', load: () => singlePlugin('html') }],
  ['xml', { parser: 'html', load: () => singlePlugin('html') }],
  ['svg', { parser: 'html', load: () => singlePlugin('html') }],
  ['md', { parser: 'markdown', load: () => singlePlugin('markdown') }],
  ['yml', { parser: 'yaml', load: () => singlePlugin('yaml') }],
  ['yaml', { parser: 'yaml', load: () => singlePlugin('yaml') }],
]);

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Format plan for a file name, or `null` when Prettier has no parser
 * here (`php/py/sql/sh/plaintext` — honest unsupported, never a guess).
 */
export function formatPlanFor(name: string): FormatPlan | null {
  const row = TABLE.get(extOf(name));
  return row === undefined ? null : { parser: row.parser };
}

/** Disabled-button reason, or `null` when formattable. */
export function unsupportedReason(name: string): string | null {
  const ext = extOf(name);
  if (TABLE.has(ext)) return null;
  return ext === '' ? 'Prettier has no parser for extensionless files' : `Prettier has no ${ext} parser here`;
}

/**
 * Format file content in place. Resolves the formatted text; rejects
 * with the syntax `Error` (caller keeps content + shows inline) or
 * an unsupported `Error` (caller disables instead of calling).
 */
export async function formatCode(name: string, content: string): Promise<string> {
  const ext = extOf(name);
  const row = TABLE.get(ext);
  if (row === undefined) throw new Error(unsupportedReason(name) ?? 'Unsupported file');
  const { format } = await import('prettier/standalone');
  return format(content, { parser: row.parser, plugins: await row.load() });
}

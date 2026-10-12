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

async function postcssPlugins(): Promise<Plugin[]> {
  const postcss = await import('prettier/plugins/postcss');
  return [postcss as unknown as Plugin];
}

async function htmlPlugins(): Promise<Plugin[]> {
  const html = await import('prettier/plugins/html');
  return [html as unknown as Plugin];
}

async function markdownPlugins(): Promise<Plugin[]> {
  const markdown = await import('prettier/plugins/markdown');
  return [markdown as unknown as Plugin];
}

async function yamlPlugins(): Promise<Plugin[]> {
  const yaml = await import('prettier/plugins/yaml');
  return [yaml as unknown as Plugin];
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
  ['css', { parser: 'css', load: postcssPlugins }],
  ['html', { parser: 'html', load: htmlPlugins }],
  ['htm', { parser: 'html', load: htmlPlugins }],
  ['xml', { parser: 'html', load: htmlPlugins }],
  ['svg', { parser: 'html', load: htmlPlugins }],
  ['md', { parser: 'markdown', load: markdownPlugins }],
  ['yml', { parser: 'yaml', load: yamlPlugins }],
  ['yaml', { parser: 'yaml', load: yamlPlugins }],
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

import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import type { LanguageSupport } from '@codemirror/language';

/** Editor + preview language for one file extension. */
export interface CodeLanguage {
  /** CodeMirror extension (empty = plain text editing). */
  cm: LanguageSupport[];
  /** lowlight grammar key (`plaintext` = no highlighting). */
  lowlight: string;
}

function one(ext: string, cm: LanguageSupport, lowlight: string): [string, CodeLanguage] {
  return [ext, { cm: [cm], lowlight }];
}

/**
 * Extension → language map. Shell scripts highlight in preview only
 * (`bash` grammar) — no shell CodeMirror package is installed, so they
 * edit as plain text. Unknown extensions stay plain in both modes.
 */
const TABLE = new Map<string, CodeLanguage>([
  one('js', javascript({ jsx: true }), 'javascript'),
  one('jsx', javascript({ jsx: true }), 'javascript'),
  one('mjs', javascript(), 'javascript'),
  one('cjs', javascript(), 'javascript'),
  one('ts', javascript({ typescript: true }), 'typescript'),
  one('tsx', javascript({ jsx: true, typescript: true }), 'typescript'),
  one('json', json(), 'json'),
  one('py', python(), 'python'),
  one('css', css(), 'css'),
  one('html', html(), 'xml'),
  one('htm', html(), 'xml'),
  one('xml', html(), 'xml'),
  one('svg', html(), 'xml'),
  one('md', markdown(), 'markdown'),
  one('yml', yaml(), 'yaml'),
  one('yaml', yaml(), 'yaml'),
  one('sql', sql(), 'sql'),
  one('php', php(), 'php'),
]);

const PLAIN: CodeLanguage = { cm: [], lowlight: 'plaintext' };
const SHELL: CodeLanguage = { cm: [], lowlight: 'bash' };

/** Language for a file name (extension after the last dot, lowercase). */
export function languageFor(name: string): CodeLanguage {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return SHELL;
  return TABLE.get(ext) ?? PLAIN;
}

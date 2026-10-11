import type { ReactElement } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { common, createLowlight } from 'lowlight';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import 'highlight.js/styles/github-dark.css';
import { languageFor } from './languages.js';

/** Shared lowlight instance (37 common grammars, registered once). */
const lowlight = createLowlight(common);

/**
 * Code preview (lowlight, read-only mode): highlighted code as real
 * React elements via HAST — never `innerHTML`, per the spec §5 ban.
 * Unknown extensions and highlight failures fall back to plain text.
 */
export function CodePreview({ filename, code }: { filename: string; code: string }): ReactElement {
  const grammar = languageFor(filename).lowlight;
  if (grammar === 'plaintext') {
    return (
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono text-xs">{code}</pre>
    );
  }
  try {
    const tree = lowlight.highlight(grammar, code);
    return (
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono text-xs">
        {toJsxRuntime(tree, { Fragment, jsx, jsxs })}
      </pre>
    );
  } catch {
    return (
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono text-xs">{code}</pre>
    );
  }
}

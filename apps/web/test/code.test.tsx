// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';
import { CodeEditor } from '../src/components/code/CodeEditor.js';
import { CodePreview } from '../src/components/code/CodePreview.js';
import { languageFor } from '../src/components/code/languages.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('web code languages', () => {
  it('maps extensions to editor and preview grammars', () => {
    expect(languageFor('a.js').lowlight).toBe('javascript');
    expect(languageFor('a.tsx').lowlight).toBe('typescript');
    expect(languageFor('a.py').lowlight).toBe('python');
    expect(languageFor('a.php').lowlight).toBe('php');
    expect(languageFor('run.sh').lowlight).toBe('bash');
    expect(languageFor('run.sh').cm).toEqual([]);
    expect(languageFor('nope.xyz').lowlight).toBe('plaintext');
    expect(languageFor('a.js').cm.length).toBeGreaterThan(0);
  });
});

describe('web code editor', () => {
  it('renders highlighted lines and reports edits', async () => {
    const onChange = vi.fn();
    const holder: { view: EditorView | null } = { view: null };
    await act(async () => {
      render(
        <CodeEditor
          filename="a.js"
          value="const a = 1;"
          onChange={onChange}
          ariaLabel="Edit a.js"
          viewRef={(v) => { holder.view = v; }}
        />,
      );
    });
    expect(document.querySelector('.cm-editor')).not.toBeNull();
    expect(document.querySelector('.cm-lineNumbers')).not.toBeNull();
    expect(document.querySelector('.cm-content')?.textContent).toContain('const a = 1;');
    await act(async () => {
      const doc = holder.view?.state.doc;
      holder.view?.dispatch({ changes: { from: 0, to: doc?.length ?? 0, insert: 'const b = 2;' } });
    });
    expect(onChange).toHaveBeenCalledWith('const b = 2;');
  });

  it('syncs external resets and destroys on unmount', async () => {
    const holder: { view: EditorView | null } = { view: null };
    const { rerender, unmount } = render(
      <CodeEditor
        filename="a.js"
        value="one"
        onChange={() => {}}
        ariaLabel="Edit a.js"
        viewRef={(v) => { holder.view = v; }}
      />,
    );
    expect(holder.view).not.toBeNull();
    if (holder.view === null) throw new Error('editor view missing');
    rerender(
      <CodeEditor
        filename="a.js"
        value="two"
        onChange={() => {}}
        ariaLabel="Edit a.js"
        viewRef={(v) => { holder.view = v; }}
      />,
    );
    expect(holder.view?.state.doc.toString()).toBe('two');
    unmount();
    expect(holder.view).toBeNull();
  });
});

describe('web code preview', () => {
  it('highlights known grammars as real elements', () => {
    render(<CodePreview filename="a.js" code="const a = 1;" />);
    expect(screen.getByText('const')).not.toBeNull();
    expect(document.querySelector('span.hljs-keyword')).not.toBeNull();
  });

  it('falls back to plain text for unknown types', () => {
    render(<CodePreview filename="a.xyz" code="raw & <data>" />);
    expect(screen.getByText('raw & <data>')).not.toBeNull();
    expect(document.querySelector('span[class*="hljs-"]')).toBeNull();
  });
});

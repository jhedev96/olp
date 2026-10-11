import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, highlightActiveLine, lineNumbers } from '@codemirror/view';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import type { EditorView as EditorViewType } from '@codemirror/view';
import { languageFor } from './languages.js';

/** Minimal dark palette (OLP tokens — avoids a theme package). */
const olpTheme = EditorView.theme({
  '&': {
    height: '16rem',
    fontSize: '13px',
    backgroundColor: 'transparent',
    border: '1px solid #404040',
    borderRadius: '0.375rem',
  },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid #404040', color: '#737373' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-activeLine': { backgroundColor: 'rgba(78, 222, 163, 0.06)' },
  '.cm-cursor': { borderLeftColor: '#4edea3' },
});

function extensionsFor(filename: string): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    bracketMatching(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    syntaxHighlighting(defaultHighlightStyle),
    olpTheme,
    ...languageFor(filename).cm,
  ];
}

/**
 * Code editor (CodeMirror 6, edit mode): line numbers, bracket match,
 * history, active-line, per-extension highlighting. `value` is the
 * source of truth — external resets (Discard) sync the doc when they
 * differ. `viewRef` is a test seam (production ignores it).
 */
export function CodeEditor({
  filename,
  value,
  onChange,
  ariaLabel,
  viewRef,
}: {
  filename: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  viewRef?: (view: EditorViewType | null) => void;
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRefInner = useRef<EditorViewType | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...extensionsFor(filename),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRefInner.current = view;
    viewRef?.(view);
    return () => {
      view.destroy();
      viewRefInner.current = null;
      viewRef?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename]);

  useEffect(() => {
    const view = viewRefInner.current;
    if (view === null) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} role="textbox" aria-label={ariaLabel} aria-multiline="true" />;
}

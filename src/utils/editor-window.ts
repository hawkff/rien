// What the editor windows (proxy exits, cookies) share: finding and making
// elements, their wording, and the colors of the text editor
import { EditorView } from '@codemirror/view';

export const get = <T extends HTMLElement>(id: string, type: new () => T) => {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`No #${id}`);
  return element;
};

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]>,
  ...children: (Node | string)[]
) => {
  const element = document.createElement(tag);
  Object.assign(element, props);
  element.append(...children);
  return element;
};

/** Fills in a raw translation's {{names}}; Rien sends them raw */
export const wording =
  (words: Record<string, string>) =>
  (key: string, values: Record<string, string | number> = {}) =>
    (words[key] ?? key).replaceAll(/\{\{(\w+)\}\}/g, (_, name: string) =>
      String(values[name] ?? ''),
    );

export const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: 'var(--text)',
      backgroundColor: 'var(--panel)',
    },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '13px',
    },
    '.cm-content': { caretColor: 'var(--text)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '.cm-gutters': {
      color: 'var(--faint)',
      backgroundColor: 'var(--panel)',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'rgb(255 255 255 / 5%)' },
    '.cm-activeLineGutter': {
      color: 'var(--text)',
      backgroundColor: 'transparent',
    },
    '.cm-panels': {
      color: 'var(--text)',
      backgroundColor: 'var(--page)',
      borderTop: '1px solid var(--line)',
    },
    '.cm-vim-panel input': { color: 'var(--text)' },
  },
  { dark: true },
);

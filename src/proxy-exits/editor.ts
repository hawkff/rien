// The proxy exits editor: a list to switch exits on and off, order them and
// pick the one in use, and the same list as text, with Vim keys if wanted
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  Compartment,
  type EditorState,
  RangeSetBuilder,
  Transaction,
} from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { Vim, vim } from '@replit/codemirror-vim';

import {
  type ExitEntry,
  exitAddress,
  exitsText,
  fromEntries,
  lineKind,
  parseExitText,
  pastedExits,
  toEntries,
} from '../utils/proxy-exits';

declare global {
  interface Window {
    // From preload.cjs
    exits: {
      load: () => Promise<{
        list: string[];
        inUse: string | null;
        text: Record<string, string>;
      }>;
      save: (list: string[], use?: string) => Promise<unknown>;
      close: () => void;
    };
  }
}

const get = <T extends HTMLElement>(id: string, type: new () => T) => {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`No #${id}`);
  return element;
};

const intro = get('intro', HTMLParagraphElement);
const showList = get('show-list', HTMLButtonElement);
const showText = get('show-text', HTMLButtonElement);
const shuffleButton = get('shuffle', HTMLButtonElement);
const cleanUp = get('clean-up', HTMLButtonElement);
const vimSwitch = get('vim-switch', HTMLLabelElement);
const vimBox = get('vim', HTMLInputElement);
const vimLabel = get('vim-label', HTMLSpanElement);
const list = get('list', HTMLUListElement);
const addForm = get('add', HTMLFormElement);
const addInput = get('add-input', HTMLInputElement);
const addButton = get('add-button', HTMLButtonElement);
const textBox = get('text', HTMLDivElement);
const help = get('help', HTMLParagraphElement);
const statusLine = get('status', HTMLParagraphElement);
const cancel = get('cancel', HTMLButtonElement);
const saveButton = get('save', HTMLButtonElement);

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]>,
  ...children: (Node | string)[]
) => {
  const element = document.createElement(tag);
  Object.assign(element, props);
  element.append(...children);
  return element;
};

let words: Record<string, string> = {};
let entries: ExitEntry[] = [];
let inUse: string | null = null;
// An exit picked with Use, which Rien moves to on saving
let picked: string | undefined;
let view = localStorage.getItem('exits-view') === 'text' ? 'text' : 'list';
// A message for the status line until the next change
let note = '';
let refocus: { index: number; name: string } | undefined;
let editor: EditorView;
const vimMode = new Compartment();

const say = (key: string, values: Record<string, string | number> = {}) =>
  (words[key] ?? key).replaceAll(/\{\{(\w+)\}\}/g, (_, name: string) =>
    String(values[name] ?? ''),
  );

/** The exit in use after saving: the one picked, else the one in use, else the first on */
const target = (all: ExitEntry[]) => {
  const on = all.filter((entry) => entry.on).map((entry) => entry.address);
  return (
    [picked, inUse].find((address) => address && on.includes(address)) ??
    on.at(0)
  );
};

const count = (all: ExitEntry[]) =>
  say(all.length === 1 ? 'count-one' : 'count-other', {
    count: all.length,
    on: all.filter((entry) => entry.on).length,
  });

const shuffled = (all: ExitEntry[]) => {
  const out = [...all];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const text = () => editor.state.doc.toString();
const setText = (value: string, undoable: boolean) =>
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: value },
    annotations: Transaction.addToHistory.of(undoable),
  });

const lineMarks = {
  bad: Decoration.line({ class: 'cm-bad' }),
  off: Decoration.line({ class: 'cm-off' }),
  comment: Decoration.line({ class: 'cm-note' }),
};

const decorate = (state: EditorState) => {
  const using = target(parseExitText(state.doc.toString()).entries);
  const marks = new RangeSetBuilder<Decoration>();
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const kind = lineKind(line.text);
    if (kind === 'exit') {
      if (using && exitAddress(line.text.trim()) === using) {
        marks.add(
          line.from,
          line.from,
          Decoration.line({
            class: 'cm-in-use',
            attributes: { 'data-label': say('in-use') },
          }),
        );
      }
    } else if (kind !== 'empty') {
      marks.add(line.from, line.from, lineMarks[kind]);
    }
  }
  return marks.finish();
};

const theme = EditorView.theme(
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
    '.cm-bad': { backgroundColor: 'var(--bad-bg)' },
    '.cm-off': { color: 'var(--faint)' },
    '.cm-note': { color: 'var(--faint)', fontStyle: 'italic' },
    '.cm-in-use': { color: 'var(--accent)' },
    '.cm-in-use::after': {
      content: 'attr(data-label)',
      marginLeft: '2ch',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '12px',
    },
  },
  { dark: true },
);

const change = (edit: () => void, focus?: typeof refocus) => {
  edit();
  note = '';
  refocus = focus;
  render();
};

const move = (index: number, by: number) =>
  change(
    () => {
      const [entry] = entries.splice(index, 1);
      entries.splice(index + by, 0, entry);
    },
    { index: index + by, name: by < 0 ? 'up' : 'down' },
  );

const renderList = () => {
  const using = target(entries);
  let number = 0;
  const rows = entries.map((entry, index) => {
    const label = (key: string) => `${say(key)}: ${entry.address}`;
    const current = entry.address === using;
    const button = (
      name: string,
      sign: string,
      key: string,
      props: Partial<HTMLButtonElement>,
    ) =>
      h('button', {
        type: 'button',
        name,
        textContent: sign,
        title: say(key),
        ariaLabel: label(key),
        ...props,
      });
    return h(
      'li',
      { className: `${entry.on ? '' : 'off'} ${current ? 'current' : ''}` },
      h('input', {
        type: 'checkbox',
        name: 'on',
        checked: entry.on,
        ariaLabel: label('on'),
        onchange: () =>
          change(
            () => {
              entry.on = !entry.on;
            },
            { index, name: 'on' },
          ),
      }),
      h('span', {
        className: 'number',
        textContent: entry.on ? String(++number) : '',
      }),
      h('span', {
        className: 'address',
        textContent: entry.address,
        title: entry.address,
      }),
      current
        ? h('span', { className: 'mark', textContent: say('in-use') })
        : button('use', say('use'), 'use', {
            title: say('use-tooltip'),
            disabled: !entry.on,
            onclick: () =>
              change(
                () => {
                  picked = entry.address;
                },
                { index, name: 'on' },
              ),
          }),
      button('up', '↑', 'move-up', {
        disabled: index === 0,
        onclick: () => move(index, -1),
      }),
      button('down', '↓', 'move-down', {
        disabled: index === entries.length - 1,
        onclick: () => move(index, 1),
      }),
      button('remove', '✕', 'remove', {
        onclick: () =>
          change(
            () => {
              entries.splice(index, 1);
            },
            { index, name: 'remove' },
          ),
      }),
    );
  });
  list.replaceChildren(...rows);
  if (rows.length === 0) {
    list.append(h('li', { className: 'empty', textContent: say('empty') }));
  }
  if (!refocus) return;
  // The row's own buttons were made again: keep the keyboard where it was
  const row = list.children.item(Math.min(refocus.index, rows.length - 1));
  const again =
    row?.querySelector<HTMLElement>(`[name="${refocus.name}"]:enabled`) ??
    row?.querySelector<HTMLElement>('input') ??
    addInput;
  again.focus();
  refocus = undefined;
};

const render = () => {
  const asText = view === 'text';
  list.hidden = asText;
  addForm.hidden = asText;
  textBox.hidden = !asText;
  help.hidden = !asText;
  vimSwitch.hidden = !asText;
  showList.ariaPressed = String(!asText);
  showText.ariaPressed = String(asText);
  const { entries: all, bad } = asText
    ? parseExitText(text())
    : { entries, bad: [] };
  cleanUp.hidden = bad.length === 0;
  saveButton.disabled = bad.length > 0;
  shuffleButton.disabled = bad.length > 0;
  // Switching back would drop the lines that aren't addresses
  showList.disabled = bad.length > 0;
  const problem =
    bad.length === 0
      ? ''
      : bad.length === 1
        ? say('bad-line', bad[0])
        : `${say('bad-line', bad[0])} ${say('bad-more', { count: bad.length - 1 })}`;
  statusLine.textContent = note || problem || count(all);
  statusLine.classList.toggle('bad', Boolean(note || problem));
  if (!asText) renderList();
};

const add = (value: string) => {
  const { entries: found, bad } = parseExitText(value);
  const known = new Set(entries.map((entry) => entry.address));
  const fresh = found.filter((entry) => !known.has(entry.address));
  entries.push(...fresh);
  const rest = bad.map((part) => part.text);
  addInput.value = rest.join(' ');
  note = rest.length > 0 ? say('not-addresses', { bad: rest.join(', ') }) : '';
  render();
  if (fresh.length > 0) {
    list.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }
};

const setView = (next: string) => {
  if (next === view) return;
  if (next === 'text') setText(exitsText(entries), false);
  else entries = parseExitText(text()).entries;
  view = next;
  localStorage.setItem('exits-view', next);
  note = '';
  render();
  (next === 'text' ? editor : addInput).focus();
};

const setVim = (on: boolean) => {
  vimBox.checked = on;
  localStorage.setItem('exits-vim', on ? 'on' : '');
  editor.dispatch({
    effects: vimMode.reconfigure(on ? vim({ status: true }) : []),
  });
  help.textContent = on
    ? `${say('text-help')} ${say('vim-help')}`
    : say('text-help');
};

const save = async () => {
  if (saveButton.disabled || document.body.inert) return;
  const all = view === 'text' ? parseExitText(text()).entries : entries;
  // Nothing changes while Rien saves: the window closes after it
  document.body.inert = true;
  try {
    // Only an exit picked by hand: Rien may have moved since the editor opened
    await window.exits.save(fromEntries(all), picked);
    window.exits.close();
  } catch (error) {
    document.body.inert = false;
    note = error instanceof Error ? error.message : String(error);
    render();
  }
};

// The editor is a dialog: saving closes it, as with the buttons
Vim.defineEx('write', 'w', () => save());
Vim.defineEx('wq', 'wq', () => save());
Vim.defineEx('xit', 'x', () => save());
Vim.defineEx('quit', 'q', () => window.exits.close());

const start = (loaded: Awaited<ReturnType<Window['exits']['load']>>) => {
  words = loaded.text;
  entries = toEntries(loaded.list);
  inUse = loaded.inUse;
  document.title = say('title');
  intro.textContent = say('intro');
  showList.textContent = say('list');
  showText.textContent = say('text');
  shuffleButton.textContent = say('shuffle');
  cleanUp.textContent = say('clean-up');
  cleanUp.title = say('clean-up-tooltip');
  vimLabel.textContent = say('vim');
  addInput.placeholder = say('add-placeholder');
  addInput.ariaLabel = say('add-placeholder');
  addButton.textContent = say('add');
  cancel.textContent = say('cancel');
  saveButton.textContent = say('save');

  editor = new EditorView({
    parent: textBox,
    extensions: [
      vimMode.of([]),
      // Ahead of the default keys, where Mod-Enter adds a line
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            save();
            return true;
          },
        },
      ]),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      // A pasted list, with commas or spaces, becomes an exit per line
      EditorView.clipboardInputFilter.of(pastedExits),
      EditorView.decorations.compute(['doc'], decorate),
      EditorView.contentAttributes.of({ 'aria-label': say('text') }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        note = '';
        render();
      }),
      theme,
    ],
  });

  showList.addEventListener('click', () => setView('list'));
  showText.addEventListener('click', () => setView('text'));
  shuffleButton.addEventListener('click', () => {
    if (view === 'list') {
      change(() => {
        entries = shuffled(entries);
      });
    } else {
      setText(exitsText(shuffled(parseExitText(text()).entries)), true);
    }
  });
  cleanUp.addEventListener('click', () =>
    setText(exitsText(parseExitText(text()).entries), true),
  );
  vimBox.addEventListener('change', () => {
    setVim(vimBox.checked);
    editor.focus();
  });
  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    add(addInput.value);
  });
  addInput.addEventListener('paste', (event) => {
    const pasted = event.clipboardData?.getData('text/plain') ?? '';
    // A one-line box would run the lines together
    if (!pasted.includes('\n')) return;
    event.preventDefault();
    // Pasted where the cursor is, among what the box holds already
    const { value, selectionStart: from, selectionEnd: to } = addInput;
    add(
      value.slice(0, from ?? value.length) +
        pasted +
        value.slice(to ?? value.length),
    );
  });
  cancel.addEventListener('click', () => window.exits.close());
  saveButton.addEventListener('click', () => save());
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    } else if (
      event.key === 'Escape' &&
      // Escape belongs to the text editor, and to Vim, while they have focus
      !editor.dom.contains(document.activeElement)
    ) {
      window.exits.close();
    }
  });

  setVim(localStorage.getItem('exits-vim') === 'on');
  if (view === 'text') setText(exitsText(entries), false);
  render();
  (view === 'text' ? editor : addInput).focus();
};

window.exits.load().then(start);

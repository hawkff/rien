// The cookie editor: a list of the cookies Rien holds for the music site and
// Google, without their values, and a text box to sign in with pasted cookies,
// with live checks of the paste and Vim keys if wanted
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Compartment } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { Vim, vim } from '@replit/codemirror-vim';

import { editorTheme, get, h, wording } from '../utils/editor-window';
import { checkPastedCookies } from '../utils/pasted-cookies';

import type { ListedCookie } from '../providers/cookie-editor';

declare global {
  interface Window {
    // From preload.cjs
    cookies: {
      load: () => Promise<{
        cookies: ListedCookie[];
        view: 'list' | 'text' | null;
        text: Record<string, string>;
      }>;
      remove: (
        name: string,
        domain?: string,
        path?: string,
      ) => Promise<ListedCookie[]>;
      removeAll: () => Promise<{ cookies: ListedCookie[]; failed: number }>;
      copy: (format: 'json' | 'header') => Promise<number>;
      signIn: (text: string) => Promise<{
        failed: number;
        count: number;
        // Old cookies that couldn't be removed; then none was set
        left: number;
        cookies: ListedCookie[];
      }>;
      close: () => void;
      onView: (show: (view: string) => void) => void;
    };
  }
}

const intro = get('intro', HTMLParagraphElement);
const showList = get('show-list', HTMLButtonElement);
const showText = get('show-text', HTMLButtonElement);
const vimSwitch = get('vim-switch', HTMLLabelElement);
const vimBox = get('vim', HTMLInputElement);
const vimLabel = get('vim-label', HTMLSpanElement);
const list = get('list', HTMLDivElement);
const rows = get('rows', HTMLTableSectionElement);
const listActions = get('list-actions', HTMLDivElement);
const copyJson = get('copy-json', HTMLButtonElement);
const copyHeader = get('copy-header', HTMLButtonElement);
const removeAll = get('remove-all', HTMLButtonElement);
const textBox = get('text', HTMLDivElement);
const checks = get('checks', HTMLUListElement);
const help = get('help', HTMLParagraphElement);
const confirmBox = get('confirm', HTMLDivElement);
const confirmMessage = get('confirm-message', HTMLParagraphElement);
const confirmDetail = get('confirm-detail', HTMLParagraphElement);
const confirmYes = get('confirm-yes', HTMLButtonElement);
const confirmNo = get('confirm-no', HTMLButtonElement);
const statusLine = get('status', HTMLParagraphElement);
const closeButton = get('close', HTMLButtonElement);
const signInButton = get('sign-in', HTMLButtonElement);

let say = wording({});
let cookies: ListedCookie[] = [];
let view = localStorage.getItem('cookies-view') === 'text' ? 'text' : 'list';
// A message for the status line until the next change
let note = '';
let bad = false;
let editor: EditorView;
const vimMode = new Compartment();

const tell = (message: string, isBad = false) => {
  note = message;
  bad = isBad;
  render();
};
const failed = (error: unknown) =>
  tell(error instanceof Error ? error.message : String(error), true);

const counted = (count: number) =>
  say(count === 1 ? 'count-one' : 'count-other', { count });

// Asks in the window before a step that signs out or lets the cookies out
let answer: ((yes: boolean) => void) | undefined;
const ask = (key: string) => {
  confirmMessage.textContent = say(`${key}-message`);
  confirmDetail.textContent = say(`${key}-detail`);
  confirmYes.textContent = say(key);
  confirmBox.hidden = false;
  listActions.hidden = true;
  confirmNo.focus();
  return new Promise<boolean>((resolve) => {
    answer = (yes) => {
      answer = undefined;
      confirmBox.hidden = true;
      listActions.hidden = view === 'text';
      resolve(yes);
    };
  });
};

const sameSites: Partial<Record<string, string>> = {
  no_restriction: 'SameSite=None',
  lax: 'SameSite=Lax',
  strict: 'SameSite=Strict',
};
const flags = (cookie: ListedCookie) =>
  [
    cookie.httpOnly && 'HttpOnly',
    cookie.secure && 'Secure',
    sameSites[cookie.sameSite],
  ]
    .filter(Boolean)
    .join(' · ');

const renderList = () => {
  const made = cookies.map((cookie, index) =>
    h(
      'tr',
      {},
      h('td', { className: 'name', textContent: cookie.name }),
      h('td', { className: 'site', textContent: cookie.domain ?? '' }),
      h('td', { className: 'path', textContent: cookie.path ?? '/' }),
      h('td', {
        className: 'expires',
        textContent:
          cookie.session || cookie.expirationDate === undefined
            ? say('session')
            : new Date(cookie.expirationDate * 1000).toLocaleDateString(),
      }),
      h('td', { className: 'flags', textContent: flags(cookie) }),
      h(
        'td',
        {},
        h('button', {
          type: 'button',
          name: 'remove',
          textContent: '✕',
          title: say('remove'),
          ariaLabel: `${say('remove')}: ${cookie.name}`,
          onclick: () =>
            window.cookies
              .remove(cookie.name, cookie.domain, cookie.path)
              .then((left) => {
                cookies = left;
                tell(say('removed', { name: cookie.name }));
                // The keyboard stays in the list
                (
                  rows.children
                    .item(Math.min(index, cookies.length - 1))
                    ?.querySelector('button') ?? showList
                ).focus();
              }, failed),
        }),
      ),
    ),
  );
  rows.replaceChildren(...made);
  if (made.length === 0) {
    rows.append(
      h('tr', {}, h('td', { className: 'empty', colSpan: 6 }, say('empty'))),
    );
  }
};

const renderChecks = () => {
  const check = checkPastedCookies(editor.state.doc.toString());
  const line = (text: string, kind = '') =>
    h('li', { className: kind, textContent: text });
  const items = [
    line(
      say(`format-${check.format}`, { cookies: counted(check.cookies.length) }),
      check.format === 'bad-json' ? 'bad' : '',
    ),
  ];
  if (check.cookies.length > 0) {
    items.push(
      line(
        `${say('sites')} ${Object.entries(check.sites)
          .map(([site, count]) => `${site} ${count}`)
          .join(', ')}`,
      ),
    );
  }
  if (check.format !== 'empty' && check.format !== 'bad-json') {
    items.push(
      line(
        say(`sign-in-${check.signIn}`),
        check.signIn === 'yes' ? 'good' : 'bad',
      ),
    );
  }
  if (check.skipped.length > 0) {
    const skipped = check.skipped.map(
      ({ entry, name, reason }) =>
        `${name ?? say('entry', { entry })} (${say(`skip-${reason}`)})`,
    );
    items.push(
      line(say('skipped', { count: skipped.length, list: skipped.join(', ') })),
    );
  }
  checks.replaceChildren(...items);
  signInButton.disabled = check.signIn !== 'yes';
};

const render = () => {
  const asText = view === 'text';
  list.hidden = asText;
  listActions.hidden = asText || !confirmBox.hidden;
  textBox.hidden = !asText;
  checks.hidden = !asText;
  help.hidden = !asText;
  vimSwitch.hidden = !asText;
  signInButton.hidden = !asText;
  showList.ariaPressed = String(!asText);
  showText.ariaPressed = String(asText);
  copyJson.disabled = cookies.length === 0;
  copyHeader.disabled = cookies.length === 0;
  removeAll.disabled = cookies.length === 0;
  statusLine.textContent = note || (asText ? '' : counted(cookies.length));
  statusLine.classList.toggle('bad', bad);
  if (asText) renderChecks();
  else renderList();
};

const setView = (next: string) => {
  if (next === view) return;
  answer?.(false);
  view = next;
  localStorage.setItem('cookies-view', next);
  note = '';
  bad = false;
  render();
  (next === 'text' ? editor : showList).focus();
};

const setVim = (on: boolean) => {
  vimBox.checked = on;
  localStorage.setItem('cookies-vim', on ? 'on' : '');
  editor.dispatch({
    effects: vimMode.reconfigure(on ? vim({ status: true }) : []),
  });
  help.textContent = on
    ? `${say('text-help')} ${say('vim-help')}`
    : say('text-help');
};

const signIn = async () => {
  if (view !== 'text' || signInButton.disabled || document.body.inert) return;
  // Nothing changes while Rien signs in: the window closes after it
  document.body.inert = true;
  try {
    const signedIn = await window.cookies.signIn(editor.state.doc.toString());
    if (signedIn.left > 0) {
      cookies = signedIn.cookies;
      document.body.inert = false;
      return tell(say('not-cleared'), true);
    }
    if (signedIn.failed === 0) return window.cookies.close();
    const { failed: notSet, count } = signedIn;
    cookies = signedIn.cookies;
    document.body.inert = false;
    tell(say('partly', { failed: notSet, count }), true);
  } catch (error) {
    document.body.inert = false;
    failed(error);
  }
};

const copy = async (format: 'json' | 'header') => {
  if (!(await ask('copy'))) return;
  await window.cookies.copy(format).then((count) => {
    tell(say('copied', { cookies: counted(count) }));
  }, failed);
};

// The editor is a dialog: signing in closes it, as with the button
Vim.defineEx('write', 'w', () => signIn());
Vim.defineEx('wq', 'wq', () => signIn());
Vim.defineEx('xit', 'x', () => signIn());
Vim.defineEx('quit', 'q', () => window.cookies.close());

const start = (loaded: Awaited<ReturnType<Window['cookies']['load']>>) => {
  say = wording(loaded.text);
  cookies = loaded.cookies;
  if (loaded.view) view = loaded.view;
  document.title = say('title');
  intro.textContent = say('intro');
  showList.textContent = say('list');
  showText.textContent = say('text');
  vimLabel.textContent = say('vim');
  for (const column of ['name', 'site', 'path', 'expires', 'flags']) {
    get(`head-${column}`, HTMLTableCellElement).textContent = say(column);
  }
  copyJson.textContent = say('copy-json');
  copyHeader.textContent = say('copy-header');
  removeAll.textContent = say('remove-all');
  closeButton.textContent = say('close');
  confirmNo.textContent = say('cancel');
  signInButton.textContent = say('sign-in');

  editor = new EditorView({
    parent: textBox,
    extensions: [
      vimMode.of([]),
      // Ahead of the default keys, where Mod-Enter adds a line
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            signIn();
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
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        'aria-label': say('text'),
        'spellcheck': 'false',
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        note = '';
        bad = false;
        render();
      }),
      editorTheme,
    ],
  });

  showList.addEventListener('click', () => setView('list'));
  showText.addEventListener('click', () => setView('text'));
  vimBox.addEventListener('change', () => {
    setVim(vimBox.checked);
    editor.focus();
  });
  copyJson.addEventListener('click', () => copy('json'));
  copyHeader.addEventListener('click', () => copy('header'));
  removeAll.addEventListener('click', async () => {
    if (!(await ask('remove-all'))) return;
    await window.cookies.removeAll().then((removed) => {
      cookies = removed.cookies;
      if (removed.failed > 0) tell(say('remove-failed'), true);
      else tell(say('removed-all'));
    }, failed);
  });
  confirmYes.addEventListener('click', () => answer?.(true));
  confirmNo.addEventListener('click', () => answer?.(false));
  closeButton.addEventListener('click', () => window.cookies.close());
  window.cookies.onView(setView);
  signInButton.addEventListener('click', () => signIn());
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.key !== 'Escape') return;
    if (answer) answer(false);
    else if (
      // Escape belongs to the text editor, and to Vim, while they have focus
      !editor.dom.contains(document.activeElement)
    ) {
      window.cookies.close();
    }
  });

  setVim(localStorage.getItem('cookies-vim') === 'on');
  render();
  (view === 'text' ? editor : showList).focus();
};

window.cookies.load().then(start);

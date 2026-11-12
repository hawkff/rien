// mpv's names for the keys that are not a character, and the KeyboardEvent key
// each one stands for
const namedKeys: Record<string, string> = {
  ' ': 'SPACE',
  'Enter': 'ENTER',
  'Backspace': 'BS',
  'ArrowLeft': 'LEFT',
  'ArrowRight': 'RIGHT',
  'ArrowUp': 'UP',
  'ArrowDown': 'DOWN',
  'Home': 'HOME',
  'End': 'END',
  'PageUp': 'PGUP',
  'PageDown': 'PGDWN',
};

// mpv's default bindings for these commands, in the shape of its input.conf
export const defaultKeys: Record<string, string> = {
  'SPACE': 'play-pause',
  'p': 'play-pause',
  'LEFT': 'seek -5',
  'RIGHT': 'seek 5',
  'UP': 'seek 60',
  'DOWN': 'seek -60',
  'Shift+LEFT': 'seek -1',
  'Shift+RIGHT': 'seek 1',
  '>': 'next',
  'ENTER': 'next',
  '<': 'previous',
  '9': 'volume -2',
  '0': 'volume 2',
  'm': 'mute',
  '[': 'speed-down',
  ']': 'speed-up',
  '{': 'speed-half',
  '}': 'speed-double',
  'BS': 'speed-reset',
  'f': 'fullscreen',
  'L': 'repeat-one',
};

const plainCommands = [
  'play-pause',
  'next',
  'previous',
  'mute',
  'speed-down',
  'speed-up',
  'speed-half',
  'speed-double',
  'speed-reset',
  'fullscreen',
  'repeat-one',
] as const;
const amountCommands = ['seek', 'volume'] as const;

export type Command =
  | { name: (typeof plainCommands)[number] }
  | { name: (typeof amountCommands)[number]; amount: number };

// Holding a key repeats these, as mpv does; a held toggle acts once.
export const repeatable = new Set<Command['name']>([
  'seek',
  'volume',
  'speed-down',
  'speed-up',
]);

const parseCommand = (text: unknown): Command | undefined => {
  if (typeof text !== 'string') return undefined;
  const [name, amount, ...rest] = text.trim().split(/\s+/);
  const plain = plainCommands.find((command) => command === name);
  if (plain && amount === undefined) return { name: plain };
  const withAmount = amountCommands.find((command) => command === name);
  if (withAmount && amount !== undefined && !rest.length) {
    const value = Number(amount);
    if (Number.isFinite(value)) return { name: withAmount, amount: value };
  }
  return undefined;
};

const mpvNames = new Set(Object.values(namedKeys));
// One character, which may take two UTF-16 units
const isCharacter = (key: string) => /^.$/u.test(key);
const isKeyName = (key: string) => {
  const [, name] = /^(?:Shift\+)?(.+)$/.exec(key) ?? [];
  if (mpvNames.has(name)) return true;
  // A character carries its Shift: "L", not "Shift+l"
  return key === name && isCharacter(key) && key.trim() !== '';
};

// The bindings from the plugin's `keys` option, and the entries it skips
export const parseKeys = (keys: unknown = defaultKeys) => {
  const bindings = new Map<string, Command>();
  const skipped: string[] = [];
  const isMap = !!keys && typeof keys === 'object' && !Array.isArray(keys);
  // Something other than a map stands in for all of it: mpv's defaults apply.
  if (!isMap) skipped.push(String(JSON.stringify(keys)));
  for (const [key, text] of Object.entries(isMap ? keys : defaultKeys)) {
    const command = parseCommand(text);
    if (!isKeyName(key) || !command) {
      skipped.push(`${JSON.stringify(key)}: ${JSON.stringify(text)}`);
    } else bindings.set(key, command);
  }
  return { bindings, skipped };
};

// The mpv name of a key press, or undefined when Ctrl, Meta or Alt is held:
// those combinations belong to the app and the system.
export const keyName = (
  event: Pick<
    KeyboardEvent,
    'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'
  >,
) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  const named = namedKeys[event.key];
  if (named) return event.shiftKey ? `Shift+${named}` : named;
  // The keyboard layout decides which characters need Shift
  return isCharacter(event.key) ? event.key : undefined;
};

// The parts of an element the skip rules read; window and document have none
type PathNode = {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
};

const role = (node: PathNode) => node.getAttribute?.('role') ?? '';
const typesText = (node: PathNode) =>
  !!node.isContentEditable ||
  /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName ?? '') ||
  /^(textbox|searchbox|combobox|spinbutton)$/.test(role(node));
const activatable = (node: PathNode) =>
  /^(BUTTON|SUMMARY)$/.test(node.tagName ?? '') ||
  (node.tagName === 'A' && node.getAttribute?.('href') != null) ||
  /^(button|link|checkbox|radio|switch|tab|option|treeitem|menuitem(checkbox|radio)?)$/.test(
    role(node),
  );
const navigable = (node: PathNode) =>
  /^(slider|progressbar|scrollbar|menu|menubar|menuitem(checkbox|radio)?|listbox|option|list|listitem|tablist|tab|radiogroup|radio|tree|treeitem|grid|gridcell|row)$/.test(
    role(node),
  );
// Menus and lists move to the item whose name starts with a typed character
const typeahead = (node: PathNode) =>
  /^(menu|menubar|listbox|tree|grid)$/.test(role(node));

// Whether the focused control needs this key: path is the event's composed
// path, so it reaches into shadow roots.
const controlNeeds = (name: string, path: PathNode[]) => {
  const [target] = path;
  if (!target) return false;
  if (typesText(target)) return true;
  const key = name.replace(/^Shift\+/, '');
  if (key === 'SPACE' || key === 'ENTER') {
    const tabindex = target.getAttribute?.('tabindex');
    return (
      (tabindex != null && Number(tabindex) >= 0) || path.some(activatable)
    );
  }
  if (/^(LEFT|RIGHT|UP|DOWN|HOME|END|PGUP|PGDWN)$/.test(key)) {
    return path.some(navigable);
  }
  return isCharacter(key) && path.some(typeahead);
};

// The command for a key press, or undefined to leave the press to the page
export const commandFor = (
  event: Pick<
    KeyboardEvent,
    'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'
  > & { composedPath: () => unknown[] },
  bindings: Map<string, Command>,
) => {
  if (event.isComposing) return undefined;
  const name = keyName(event);
  const command = name ? bindings.get(name) : undefined;
  if (!name || !command) return undefined;
  return controlNeeds(name, event.composedPath() as PathNode[])
    ? undefined
    : command;
};

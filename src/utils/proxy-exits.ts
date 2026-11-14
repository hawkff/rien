// Proxy exits: a list of proxies that Rien sends its traffic through, one at
// a time, moving to the next when YouTube distrusts the one in use. An exit
// that is switched off keeps its place in the list, with a # in front.

const schemes = new Set(['socks5:', 'socks4:', 'http:', 'https:']);

/**
 * A proxy address in the form Rien keeps, or undefined when `text` isn't one.
 * A login goes before the host, as user:password@; Chromium takes none in an
 * address, so an exit with one goes through a relay (utils/socks-relay.ts).
 */
export const exitAddress = (text: string) => {
  const url = URL.parse(text);
  // A scheme's own port leaves url.port empty, as in http://host:80 or :080
  const port = url?.port || Number(/:(\d+)\/?$/.exec(text)?.[1]);
  const fine =
    url &&
    schemes.has(url.protocol) &&
    url.hostname &&
    port &&
    // SOCKS4 has a user ID but no password
    !(url.protocol === 'socks4:' && url.password) &&
    (url.pathname === '' || url.pathname === '/') &&
    !url.search &&
    !url.hash;
  if (!fine) return undefined;
  // A comma in a login stays escaped: the editor splits addresses at commas
  const escape = (part: string) => part.replaceAll(',', '%2C');
  const login =
    url.username || url.password
      ? `${escape(url.username)}${url.password ? `:${escape(url.password)}` : ''}@`
      : '';
  return `${url.protocol}//${login}${url.hostname}:${port}`;
};

// Any address, as Set proxy keeps it too: a scheme in any case
const loginPart = /^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i;
export const hasLogin = (address: string) => loginPart.test(address);
/** An address as it can be shown or logged */
export const withoutLogin = (address: string) =>
  address.replace(loginPart, '$1');
/** An address with its password hidden, for the editor's list */
export const passwordHidden = (address: string) =>
  address.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/@]*):[^/@]*@/i, '$1:•••@');

// The addresses in a text, apart at spaces and commas; a comma in a login,
// before its @, belongs to the address
const addressParts = (text: string) =>
  text.match(/(?:[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@)?[^\s,]+/gi) ?? [];

export type ExitEntry = { address: string; on: boolean };

/** The exits that are on, in their order */
export const activeExits = (list: string[]) =>
  list.filter((entry) => !entry.startsWith('#'));

export const toEntries = (list: string[]): ExitEntry[] =>
  list.map((entry) =>
    entry.startsWith('#')
      ? { address: entry.slice(1), on: false }
      : { address: entry, on: true },
  );

export const fromEntries = (entries: ExitEntry[]) =>
  entries.map(({ address, on }) => (on ? address : `#${address}`));

/**
 * A stored list made safe: every entry an address, off or on, each address
 * once. Undefined when an entry isn't one.
 */
export const checkedList = (list: unknown) => {
  if (!Array.isArray(list)) return undefined;
  const seen = new Set<string>();
  const checked: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') return undefined;
    const off = entry.startsWith('#');
    const address = exitAddress(off ? entry.slice(1) : entry);
    if (!address) return undefined;
    if (seen.has(address)) continue;
    seen.add(address);
    checked.push(off ? `#${address}` : address);
  }
  return checked;
};

/**
 * The editor's text: an exit per line, `# ` before one that's off. A line
 * starting with # that holds no address is a comment; other lines may hold
 * several addresses, separated by commas or spaces.
 */
export const parseExitText = (text: string) => {
  const entries: ExitEntry[] = [];
  const bad: { line: number; text: string }[] = [];
  const seen = new Set<string>();
  const add = (address: string, on: boolean) => {
    if (seen.has(address)) return;
    seen.add(address);
    entries.push({ address, on });
  };
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith('#')) {
      const address = exitAddress(line.slice(1).trim());
      if (address) add(address, false);
      return;
    }
    for (const part of addressParts(line)) {
      const address = exitAddress(part);
      if (address) add(address, true);
      else bad.push({ line: index + 1, text: part });
    }
  });
  return { entries, bad };
};

export const exitsText = (entries: ExitEntry[]) =>
  entries.map(({ address, on }) => (on ? address : `# ${address}`)).join('\n');

/** Pasted text with an address per line; lines starting with # stay whole */
export const pastedExits = (text: string) =>
  text
    .split(/\r?\n/)
    .flatMap((raw) => {
      const line = raw.trim();
      return line.startsWith('#') ? [line] : addressParts(line);
    })
    .filter(Boolean)
    .join('\n');

/** What a line of the editor's text holds, for its colors */
export const lineKind = (raw: string) => {
  const line = raw.trim();
  if (!line) return 'empty';
  if (line.startsWith('#')) {
    return exitAddress(line.slice(1).trim()) ? 'off' : 'comment';
  }
  return addressParts(line).every((part) => exitAddress(part)) ? 'exit' : 'bad';
};

/**
 * Chromium's proxy rules for exit `at`: that exit first, then the others in
 * order, which Chromium falls back to when one can't be reached. Never a
 * direct connection.
 */
export const exitRules = (exits: string[], at: number) =>
  [...exits.slice(at), ...exits.slice(0, at)].join(',');

/**
 * Allows at most `limit` moves in `windowMs`, so that a network where every
 * exit is distrusted doesn't make Rien hop between them all the time
 */
export const pacer = (windowMs: number) => {
  const moves: number[] = [];
  return (limit: number, now = Date.now()) => {
    while (moves.length > 0 && now - moves[0] >= windowMs) moves.shift();
    if (moves.length >= limit) return false;
    moves.push(now);
    return true;
  };
};

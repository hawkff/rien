import { isAppPage } from './app-page';

// Cookies pasted from a browser that is signed in: the JSON that cookie
// extensions export (StorageAce and Cookie-Editor write Chrome's cookie
// objects, Puppeteer's shape has `expires`), or a Cookie header as DevTools
// shows it for a request to the music site.

const site = '\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com';
// The longest Chromium keeps a cookie
const maxAge = 400 * 24 * 60 * 60;
const sameSites: Record<string, Electron.CookiesSetDetails['sameSite']> = {
  no_restriction: 'no_restriction',
  none: 'no_restriction',
  lax: 'lax',
  strict: 'strict',
  unspecified: 'unspecified',
};

// The page reads these to sign its API requests; the rest stay out of its reach
const readable = (name: string) => name.includes('APISID') || name === 'PREF';
// The music site signs its API requests with one of these
const signInNames = ['SAPISID', '__Secure-3PAPISID'];
// Chromium refuses a cookie with a control character other than tab or a
// semicolon in it, = in its name, space at either end, or more than 4096
// bytes. Such an entry is skipped before signing in removes the cookies in
// place.
const settable = (name: string, value: string) => {
  const text = name + value;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code === 0x3b || code === 0x7f || (code < 0x20 && code !== 0x09))
      return false;
  }
  return (
    name !== '' &&
    !name.includes('=') &&
    name === name.trim() &&
    value === value.trim() &&
    new TextEncoder().encode(text).length <= 4096
  );
};

export type SkipReason = 'other-site' | 'partitioned' | 'malformed' | 'expired';
/** An entry of the paste that isn't set, counted from 1 */
export type Skipped = { entry: number; name?: string; reason: SkipReason };
type Read = Electron.CookiesSetDetails | Skipped;

const fromJson = (item: unknown, index: number, now: number): Read => {
  const entry = index + 1;
  if (typeof item !== 'object' || item === null)
    return { entry, reason: 'malformed' };
  const cookie = item as Record<string, unknown>;
  const { name, value, domain } = cookie;
  if (
    typeof name !== 'string' ||
    typeof value !== 'string' ||
    typeof domain !== 'string'
  )
    return {
      entry,
      name: typeof name === 'string' ? name : undefined,
      reason: 'malformed',
    };
  if (!settable(name, value)) return { entry, name, reason: 'malformed' };
  const host = domain.replace(/^\./, '').toLowerCase();
  // Only the music site's and Google's cookies go into the window, and none
  // that a browser keeps for one top-level site only
  if (!isAppPage({ protocol: 'https:', hostname: host }))
    return { entry, name, reason: 'other-site' };
  if (cookie.partitionKey) return { entry, name, reason: 'partitioned' };
  const path = typeof cookie.path === 'string' ? cookie.path : '/';
  // A domain such as "a b.google.com" passes the site check but is no host
  if (URL.parse(`https://${host}${path}`)?.hostname !== host)
    return { entry, name, reason: 'malformed' };
  const expires = cookie.expirationDate ?? cookie.expires;
  const expirationDate =
    typeof expires === 'number' && expires > 0 ? expires : undefined;
  if (expirationDate !== undefined && expirationDate <= now)
    return { entry, name, reason: 'expired' };
  return {
    url: `https://${host}${path}`,
    name,
    value,
    // A host-only cookie gets no domain, so it stays on its own host. Without
    // the flag, as in Puppeteer's shape, a domain without a dot is a host.
    domain: (cookie.hostOnly ?? !domain.startsWith('.')) ? undefined : host,
    path,
    // The window loads these sites over HTTPS only, and Chromium refuses a
    // SameSite=None cookie that isn't Secure
    secure: true,
    httpOnly: cookie.httpOnly === true,
    expirationDate,
    sameSite: sameSites[String(cookie.sameSite).toLowerCase()],
  };
};

const fromHeader = (text: string, now: number) =>
  text
    .replace(/^cookie:\s*/i, '')
    .split(';')
    .filter((pair) => pair.trim())
    .map((pair, index): Read => {
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (at < 1 || !settable(name, value))
        return { entry: index + 1, reason: 'malformed' };
      return {
        url: `https://music.${site}/`,
        name,
        value,
        // A __Host- cookie must stay on its host
        domain: name.startsWith('__Host-') ? undefined : site,
        path: '/',
        secure: true,
        httpOnly: !readable(name),
        // A header carries no expiry
        expirationDate: now + maxAge,
      };
    });

/** Whether the cookies carry one the music site signs its API requests with */
export const signedIn = (
  cookies: Electron.CookiesSetDetails[],
  now = Date.now() / 1000,
) =>
  cookies.some(({ name, value, url, domain, path, expirationDate }) => {
    const music = `music.${site}`;
    // A host-only cookie reaches only its own host, a domain cookie its subdomains
    const reaches = domain
      ? music === domain || music.endsWith(`.${domain}`)
      : new URL(url).hostname === music;
    return (
      signInNames.includes(name ?? '') &&
      Boolean(value) &&
      reaches &&
      // The site's API is under /, so a cookie for a deeper path misses it
      (path ?? '/') === '/' &&
      (expirationDate === undefined || expirationDate > now)
    );
  });

export type PasteCheck = {
  format: 'empty' | 'json' | 'bad-json' | 'header';
  /** The cookies to set */
  cookies: Electron.CookiesSetDetails[];
  skipped: Skipped[];
  /** How many cookies go to each domain; a dot in front reaches its subdomains */
  sites: Record<string, number>;
  signIn: 'yes' | 'expired' | 'no';
};

/** What a paste holds: the cookies to set, the entries left out and why, and whether it signs in */
export const checkPastedCookies = (
  text: string,
  now = Date.now() / 1000,
): PasteCheck => {
  const trimmed = text.trim();
  let format: PasteCheck['format'] = 'header';
  let read: Read[] = [];
  if (!trimmed) format = 'empty';
  else if (!trimmed.startsWith('[')) read = fromHeader(trimmed, now);
  else {
    try {
      const list: unknown = JSON.parse(trimmed);
      format = Array.isArray(list) ? 'json' : 'bad-json';
      if (Array.isArray(list))
        read = list.map((item, index) => fromJson(item, index, now));
    } catch {
      format = 'bad-json';
    }
  }
  const cookies = read.filter(
    (item): item is Electron.CookiesSetDetails => 'url' in item,
  );
  const skipped = read.filter((item): item is Skipped => 'reason' in item);
  const sites: Record<string, number> = {};
  for (const { url, domain } of cookies) {
    const where = domain ? `.${domain}` : new URL(url).hostname;
    sites[where] = (sites[where] ?? 0) + 1;
  }
  // Expired: the paste would sign in if read before any cookie expired
  const signIn = signedIn(cookies, now)
    ? 'yes'
    : now > 0 && checkPastedCookies(text, 0).signIn === 'yes'
      ? 'expired'
      : 'no';
  return { format, cookies, skipped, sites, signIn };
};

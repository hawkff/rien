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

const fromJson = (item: unknown): Electron.CookiesSetDetails[] => {
  if (typeof item !== 'object' || item === null) return [];
  const cookie = item as Record<string, unknown>;
  const { name, value, domain } = cookie;
  if (
    typeof name !== 'string' ||
    typeof value !== 'string' ||
    typeof domain !== 'string'
  )
    return [];
  const host = domain.replace(/^\./, '').toLowerCase();
  // Only the music site's and Google's cookies go into the window, and none
  // that a browser keeps for one top-level site only
  if (!isAppPage({ protocol: 'https:', hostname: host }) || cookie.partitionKey)
    return [];
  const path = typeof cookie.path === 'string' ? cookie.path : '/';
  const expires = cookie.expirationDate ?? cookie.expires;
  return [
    {
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
      expirationDate:
        typeof expires === 'number' && expires > 0 ? expires : undefined,
      sameSite: sameSites[String(cookie.sameSite).toLowerCase()],
    },
  ];
};

const fromHeader = (text: string, now: number) =>
  text
    .replace(/^cookie:\s*/i, '')
    .split(';')
    .flatMap((pair): Electron.CookiesSetDetails[] => {
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      if (at < 1 || !name) return [];
      return [
        {
          url: `https://music.${site}/`,
          name,
          value: pair.slice(at + 1).trim(),
          // A __Host- cookie must stay on its host
          domain: name.startsWith('__Host-') ? undefined : site,
          path: '/',
          secure: true,
          httpOnly: !readable(name),
          // A header carries no expiry
          expirationDate: now + maxAge,
        },
      ];
    });

/** The cookies to set, or [] when the text holds none of the music site's or Google's. */
export const parsePastedCookies = (text: string, now = Date.now() / 1000) => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[')) return fromHeader(trimmed, now);
  try {
    const list: unknown = JSON.parse(trimmed);
    return Array.isArray(list) ? list.flatMap(fromJson) : [];
  } catch {
    return [];
  }
};

/** Whether the cookies carry one the music site signs its API requests with */
export const signedIn = (
  cookies: Electron.CookiesSetDetails[],
  now = Date.now() / 1000,
) =>
  cookies.some(({ name, value, url, domain, expirationDate }) => {
    const music = `music.${site}`;
    // A host-only cookie reaches only its own host, a domain cookie its subdomains
    const reaches = domain
      ? music === domain || music.endsWith(`.${domain}`)
      : new URL(url).hostname === music;
    return (
      (name === 'SAPISID' || name === '__Secure-3PAPISID') &&
      Boolean(value) &&
      reaches &&
      (expirationDate === undefined || expirationDate > now)
    );
  });

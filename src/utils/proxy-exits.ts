// Proxy exits: a list of proxies that Rien sends its traffic through, one at
// a time, moving to the next when YouTube distrusts the one in use.

// Chromium can't send a login to a SOCKS proxy, and takes none in an address
const schemes = new Set(['socks5:', 'socks4:', 'http:', 'https:']);

/** The exits in a text of addresses separated by commas or spaces, and the parts that aren't one */
export const parseExits = (text: string) => {
  const exits: string[] = [];
  const bad: string[] = [];
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const url = URL.parse(part);
    // A scheme's own port leaves url.port empty, as in http://host:80
    const port = url?.port || /:(\d+)\/?$/.exec(part)?.[1];
    const fine =
      url &&
      schemes.has(url.protocol) &&
      url.hostname &&
      port &&
      !url.username &&
      !url.password &&
      (url.pathname === '' || url.pathname === '/') &&
      !url.search &&
      !url.hash;
    if (fine) exits.push(`${url.protocol}//${url.hostname}:${port}`);
    else bad.push(part);
  }
  return { exits: [...new Set(exits)], bad };
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

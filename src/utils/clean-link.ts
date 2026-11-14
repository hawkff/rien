// Links to the music site without what it adds to follow who shared them,
// such as si=, a share ID that ties everyone who opens the link to its sender
const site = '\u0079\u006f\u0075\u0074\u0075\u0062\u0065';
const hosts = new Set([
  `music.${site}.com`,
  `www.${site}.com`,
  `m.${site}.com`,
  `${site}.com`,
  'youtu.be',
]);
// What names the item, and the start time that Share can add
const kept: Record<string, string[]> = {
  '/watch': ['v', 't'],
  '/playlist': ['list'],
};

/** `text` without tracking when it is a link to the site, or else as it is */
export const cleanLink = (text: string) => {
  // The URL parser drops line breaks, which would join a link to the words
  // after it: only text that is a link alone is cleaned
  const link = text.trim();
  const url = /\s/.test(link) ? null : URL.parse(link);
  if (!url || !hosts.has(url.hostname)) return text;
  const names =
    kept[url.pathname] ?? (url.hostname === 'youtu.be' ? ['t'] : []);
  for (const name of [...url.searchParams.keys()]) {
    if (!names.includes(name)) url.searchParams.delete(name);
  }
  url.hash = '';
  return url.href;
};

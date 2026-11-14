import { test, expect } from '@playwright/test';

import {
  activeExits,
  checkedList,
  exitAddress,
  hasLogin,
  passwordHidden,
  withoutLogin,
  exitRules,
  exitsText,
  fromEntries,
  lineKind,
  pacer,
  parseExitText,
  pastedExits,
  toEntries,
} from './proxy-exits';

test('exits are proxy addresses with a port and no login', () => {
  // Each in the form Rien keeps, which it takes again as it is
  for (const address of [
    'socks5://exit-1.example:1080',
    'http://10.0.0.1:8080',
    'socks4://[::1]:1080',
    // A scheme's own port, which Chromium uses when the address has none
    'http://proxy.example:80',
    'https://proxy.example:443',
  ]) {
    expect(exitAddress(address)).toBe(address);
  }
  expect(exitAddress('SOCKS5://exit-1.example:1080/')).toBe(
    'socks5://exit-1.example:1080',
  );
  expect(exitAddress('http://proxy.example:080')).toBe(
    'http://proxy.example:80',
  );
  for (const text of [
    'host:1080',
    'socks5://host',
    // SOCKS4 has a user ID but no password
    'socks4://user:pass@host:1080',
    'ftp://host:21',
    'http://host:80/path',
    '',
  ]) {
    expect(exitAddress(text)).toBeUndefined();
  }
});

test('the exit in use comes first, the others after it as fallbacks', () => {
  const exits = ['socks5://a:1', 'socks5://b:1', 'socks5://c:1'];
  expect(exitRules(exits, 0)).toBe('socks5://a:1,socks5://b:1,socks5://c:1');
  expect(exitRules(exits, 2)).toBe('socks5://c:1,socks5://a:1,socks5://b:1');
});

test('moves are paced: so many in a window, then none until it passes', () => {
  const allow = pacer(600_000);
  expect(allow(2, 0)).toBe(true);
  expect(allow(2, 1_000)).toBe(true);
  expect(allow(2, 2_000)).toBe(false);
  expect(allow(2, 600_000)).toBe(true);
  expect(allow(2, 600_500)).toBe(false);
});

test('an exit that is off keeps its place with a # in front', () => {
  const list = ['socks5://a.example:1080', '#socks5://b.example:1080'];
  expect(activeExits(list)).toEqual(['socks5://a.example:1080']);
  expect(toEntries(list)).toEqual([
    { address: 'socks5://a.example:1080', on: true },
    { address: 'socks5://b.example:1080', on: false },
  ]);
  expect(fromEntries(toEntries(list))).toEqual(list);
});

test('a stored list takes addresses only, each once', () => {
  expect(
    checkedList([
      'socks5://a.example:1080',
      '#socks5://b.example:1080/',
      'socks5://a.example:1080',
    ]),
  ).toEqual(['socks5://a.example:1080', '#socks5://b.example:1080']);
  expect(checkedList(['socks5://a.example:1080', 'nope'])).toBeUndefined();
  expect(checkedList([1])).toBeUndefined();
  expect(checkedList('socks5://a.example:1080')).toBeUndefined();
});

test('the editor text: an exit per line, # for off, comments, bad parts by line', () => {
  const text = [
    '# Chicago',
    'socks5://a.example:1080, socks5://b.example:1080',
    '#  socks5://c.example:1080',
    '',
    'socks5://d.example:1080  <- move',
    'socks5://a.example:1080',
  ].join('\n');
  const { entries, bad } = parseExitText(text);
  expect(entries).toEqual([
    { address: 'socks5://a.example:1080', on: true },
    { address: 'socks5://b.example:1080', on: true },
    { address: 'socks5://c.example:1080', on: false },
    { address: 'socks5://d.example:1080', on: true },
  ]);
  expect(bad).toEqual([
    { line: 5, text: '<-' },
    { line: 5, text: 'move' },
  ]);
  expect(exitsText(entries.slice(1, 3))).toBe(
    'socks5://b.example:1080\n# socks5://c.example:1080',
  );
  expect(text.split('\n').map(lineKind)).toEqual([
    'comment',
    'exit',
    'off',
    'empty',
    'bad',
    'exit',
  ]);
});

test('a paste becomes an address per line, # lines whole', () => {
  expect(
    pastedExits(
      '# Ashburn, VA: 2\r\nsocks5://a.example:1080, socks5://b.example:1080 socks5://c.example:1080\n',
    ),
  ).toBe(
    '# Ashburn, VA: 2\nsocks5://a.example:1080\nsocks5://b.example:1080\nsocks5://c.example:1080',
  );
});

test('an exit may have a login, kept as written and shown without it', () => {
  for (const address of [
    'socks5://alice:s%40cret@exit.example:1080',
    'socks4://alice@exit.example:1080',
    'http://bob:pw@10.0.0.1:3128',
    'https://:token@proxy.example:443',
  ]) {
    expect(exitAddress(address)).toBe(address);
    expect(hasLogin(address)).toBe(true);
  }
  expect(exitAddress('SOCKS5://alice:pw@exit.example:1080/')).toBe(
    'socks5://alice:pw@exit.example:1080',
  );
  expect(withoutLogin('socks5://alice:s%40cret@exit.example:1080')).toBe(
    'socks5://exit.example:1080',
  );
  expect(withoutLogin('socks5://exit.example:1080')).toBe(
    'socks5://exit.example:1080',
  );
  // As Set proxy keeps an address: as typed
  expect(withoutLogin('SOCKS5://alice:secret@exit.example:1080')).toBe(
    'SOCKS5://exit.example:1080',
  );
  // A comma in a login stays escaped, and the text view keeps the exit whole
  const comma = exitAddress('socks5://alice:p,ass@exit.example:1080');
  expect(comma).toBe('socks5://alice:p%2Cass@exit.example:1080');
  expect(parseExitText(comma!).entries).toEqual([{ address: comma, on: true }]);
  // Typed with a comma in the password, among other exits
  expect(
    parseExitText(
      'socks5://alice:p,ass@exit.example:1080, socks5://b.example:1080,http://c.example:8080',
    ).entries.map((entry) => entry.address),
  ).toEqual([
    'socks5://alice:p%2Cass@exit.example:1080',
    'socks5://b.example:1080',
    'http://c.example:8080',
  ]);
  expect(pastedExits('socks5://alice:p,ass@exit.example:1080 x')).toBe(
    'socks5://alice:p,ass@exit.example:1080\nx',
  );
  expect(hasLogin('socks5://exit.example:1080')).toBe(false);
  expect(passwordHidden('http://bob:pw@10.0.0.1:3128')).toBe(
    'http://bob:•••@10.0.0.1:3128',
  );
  expect(passwordHidden('socks4://alice@exit.example:1080')).toBe(
    'socks4://alice@exit.example:1080',
  );
  // A stored list keeps logins, an exit that is off too
  expect(
    checkedList(['socks5://a:b@x.example:1080', '#http://c:d@y.example:8080']),
  ).toEqual(['socks5://a:b@x.example:1080', '#http://c:d@y.example:8080']);
});

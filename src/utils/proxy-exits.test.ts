import { test, expect } from '@playwright/test';

import { exitRules, pacer, parseExits } from './proxy-exits';

test('exits are proxy addresses with a port and no login', () => {
  expect(
    parseExits(
      'socks5://exit-1.example:1080, http://10.0.0.1:8080\nsocks4://[::1]:1080 socks5://exit-1.example:1080',
    ),
  ).toEqual({
    exits: [
      'socks5://exit-1.example:1080',
      'http://10.0.0.1:8080',
      'socks4://[::1]:1080',
    ],
    bad: [],
  });
  expect(
    parseExits(
      'host:1080 socks5://host socks5://user:pass@host:1080 ftp://host:21 http://host:80/path',
    ).bad,
  ).toEqual([
    'host:1080',
    'socks5://host',
    'socks5://user:pass@host:1080',
    'ftp://host:21',
    'http://host:80/path',
  ]);
  expect(parseExits('  ')).toEqual({ exits: [], bad: [] });
  // A scheme's own port, which Chromium uses when the address has none
  expect(
    parseExits('http://proxy.example:80 https://proxy.example:443'),
  ).toEqual({
    exits: ['http://proxy.example:80', 'https://proxy.example:443'],
    bad: [],
  });
  // What the box saves, it takes again
  const saved = parseExits(
    'http://proxy.example:80, socks4://[::1]:1080',
  ).exits;
  expect(parseExits(saved.join(', ')).exits).toEqual(saved);
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

import { test, expect } from '@playwright/test';

import { parsePastedCookies, signedIn } from './pasted-cookies';

const site = '\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com';

test('a Cookie header becomes the music site’s cookies', () => {
  const cookies = parsePastedCookies(
    'Cookie: SID=a1; SAPISID=b2/c; __Secure-3PAPISID=d=4; PREF=f6=1; broken; =x; __Host-T=t',
    1000,
  );
  expect(cookies.map(({ name, value }) => [name, value])).toEqual([
    ['SID', 'a1'],
    ['SAPISID', 'b2/c'],
    ['__Secure-3PAPISID', 'd=4'],
    ['PREF', 'f6=1'],
    ['__Host-T', 't'],
  ]);
  expect(cookies.at(-1)?.domain).toBeUndefined();
  expect(cookies[0]).toMatchObject({
    url: `https://music.${site}/`,
    domain: site,
    secure: true,
    httpOnly: true,
    expirationDate: 1000 + 400 * 24 * 60 * 60,
  });
  // The page reads these to sign its requests
  expect(
    cookies.filter((cookie) => !cookie.httpOnly).map(({ name }) => name),
  ).toEqual(['SAPISID', '__Secure-3PAPISID', 'PREF']);
  expect(signedIn(cookies, 1000)).toBe(true);
});

test('an extension’s JSON keeps each cookie’s domain, expiry and flags', () => {
  const cookies = parsePastedCookies(`[
    {"domain": ".${site}", "name": "SAPISID", "value": "s", "path": "/", "expirationDate": 2000000000.5, "hostOnly": false, "httpOnly": false, "secure": true, "sameSite": "unspecified", "session": false},
    {"domain": "music.${site}", "name": "HOST", "value": "h", "path": "/", "hostOnly": true, "httpOnly": true, "secure": true, "sameSite": "lax", "session": true},
    {"domain": ".google.com", "name": "NID", "value": "n", "path": "/", "expires": -1, "httpOnly": true, "secure": true, "sameSite": "None"},
    {"domain": ".example.com", "name": "SAPISID", "value": "other site", "path": "/"},
    {"domain": ".${site}", "name": "PARTITIONED", "value": "p", "path": "/", "partitionKey": {"topLevelSite": "https://example.com"}},
    {"domain": "music.${site}", "name": "PUPPETEER_HOST", "value": "q", "path": "/", "expires": 2000000000},
    {"name": "no domain", "value": "x"}
  ]`);
  expect(cookies).toEqual([
    {
      url: `https://${site}/`,
      name: 'SAPISID',
      value: 's',
      domain: site,
      path: '/',
      secure: true,
      httpOnly: false,
      expirationDate: 2000000000.5,
      sameSite: 'unspecified',
    },
    {
      url: `https://music.${site}/`,
      name: 'HOST',
      value: 'h',
      domain: undefined,
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: undefined,
      sameSite: 'lax',
    },
    {
      url: 'https://google.com/',
      name: 'NID',
      value: 'n',
      domain: 'google.com',
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: undefined,
      sameSite: 'no_restriction',
    },
    {
      url: `https://music.${site}/`,
      name: 'PUPPETEER_HOST',
      value: 'q',
      domain: undefined,
      path: '/',
      secure: true,
      httpOnly: false,
      expirationDate: 2000000000,
      sameSite: undefined,
    },
  ]);
});

test('text without the music site’s cookies gives none', () => {
  expect(parsePastedCookies('[not json')).toEqual([]);
  expect(parsePastedCookies('{"name": "SAPISID"}')).toEqual([]);
  expect(parsePastedCookies('')).toEqual([]);
  // Signed out: cookies, but none that signs requests
  expect(signedIn(parsePastedCookies('YSC=a; VISITOR_INFO1_LIVE=b'))).toBe(
    false,
  );
  // A SAPISID that can't reach the music site, is empty or has expired
  for (const cookie of [
    '{"domain": ".google.com", "name": "SAPISID", "value": "s", "path": "/"}',
    `{"domain": "www.${site}", "hostOnly": true, "name": "SAPISID", "value": "s", "path": "/"}`,
    `{"domain": ".${site}", "name": "SAPISID", "value": "", "path": "/"}`,
    `{"domain": ".${site}", "name": "SAPISID", "value": "s", "path": "/", "expirationDate": 1}`,
  ])
    expect(signedIn(parsePastedCookies(`[${cookie}]`))).toBe(false);
  expect(
    signedIn(
      parsePastedCookies(
        `[{"domain": "music.${site}", "hostOnly": true, "name": "SAPISID", "value": "s", "path": "/"}]`,
      ),
    ),
  ).toBe(true);
});

import { test, expect } from '@playwright/test';

import { checkPastedCookies, signedIn } from './pasted-cookies';

const site = '\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com';

test('a Cookie header becomes the music site’s cookies', () => {
  const check = checkPastedCookies(
    'Cookie: SID=a1; SAPISID=b2/c; __Secure-3PAPISID=d=4; PREF=f6=1; broken; =x; __Host-T=t',
    1000,
  );
  const { cookies } = check;
  expect(check).toMatchObject({
    format: 'header',
    skipped: [
      { entry: 5, reason: 'malformed' },
      { entry: 6, reason: 'malformed' },
    ],
    sites: { [`.${site}`]: 4, [`music.${site}`]: 1 },
    signIn: 'yes',
  });
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
  const { cookies, ...check } = checkPastedCookies(`[
    {"domain": ".${site}", "name": "SAPISID", "value": "s", "path": "/", "expirationDate": 2000000000.5, "hostOnly": false, "httpOnly": false, "secure": true, "sameSite": "unspecified", "session": false},
    {"domain": "music.${site}", "name": "HOST", "value": "h", "path": "/", "hostOnly": true, "httpOnly": true, "secure": true, "sameSite": "lax", "session": true},
    {"domain": ".google.com", "name": "NID", "value": "n", "path": "/", "expires": -1, "httpOnly": true, "secure": true, "sameSite": "None"},
    {"domain": ".example.com", "name": "SAPISID", "value": "other site", "path": "/"},
    {"domain": ".${site}", "name": "PARTITIONED", "value": "p", "path": "/", "partitionKey": {"topLevelSite": "https://example.com"}},
    {"domain": "music.${site}", "name": "PUPPETEER_HOST", "value": "q", "path": "/", "expires": 2000000000},
    {"name": "no domain", "value": "x"},
    {"domain": "a b.google.com", "name": "SPACE", "value": "x", "path": "/"},
    5
  ]`);
  expect(check).toEqual({
    format: 'json',
    skipped: [
      { entry: 4, name: 'SAPISID', reason: 'other-site' },
      { entry: 5, name: 'PARTITIONED', reason: 'partitioned' },
      { entry: 7, name: 'no domain', reason: 'malformed' },
      { entry: 8, name: 'SPACE', reason: 'malformed' },
      { entry: 9, reason: 'malformed' },
    ],
    sites: { [`.${site}`]: 1, [`music.${site}`]: 2, '.google.com': 1 },
    signIn: 'yes',
  });
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
  const parse = (text: string) => checkPastedCookies(text).cookies;
  expect(checkPastedCookies('[not json')).toMatchObject({
    format: 'bad-json',
    cookies: [],
  });
  expect(checkPastedCookies('{"name": "SAPISID"}')).toMatchObject({
    format: 'header',
    cookies: [],
    skipped: [{ entry: 1, reason: 'malformed' }],
    signIn: 'no',
  });
  expect(checkPastedCookies('  ')).toMatchObject({
    format: 'empty',
    cookies: [],
    skipped: [],
  });
  // Signed out: cookies, but none that signs requests
  expect(signedIn(parse('YSC=a; VISITOR_INFO1_LIVE=b'))).toBe(false);
  // A SAPISID that can't reach the music site or is empty
  for (const cookie of [
    '{"domain": ".google.com", "name": "SAPISID", "value": "s", "path": "/"}',
    `{"domain": "www.${site}", "hostOnly": true, "name": "SAPISID", "value": "s", "path": "/"}`,
    `{"domain": ".${site}", "name": "SAPISID", "value": "", "path": "/"}`,
    `{"domain": ".${site}", "name": "SAPISID", "value": "s", "path": "/account"}`,
  ])
    expect(checkPastedCookies(`[${cookie}]`).signIn).toBe('no');
  expect(
    checkPastedCookies(
      `[{"domain": "music.${site}", "hostOnly": true, "name": "SAPISID", "value": "s", "path": "/"}]`,
    ).signIn,
  ).toBe('yes');
});

test('an expired cookie is left out, and an expired sign-in says so', () => {
  const check = checkPastedCookies(
    `[
      {"domain": ".${site}", "name": "SAPISID", "value": "s", "path": "/", "expirationDate": 999},
      {"domain": ".${site}", "name": "LATER", "value": "l", "path": "/", "expirationDate": 1001}
    ]`,
    1000,
  );
  expect(check.cookies.map(({ name }) => name)).toEqual(['LATER']);
  expect(check.skipped).toEqual([
    { entry: 1, name: 'SAPISID', reason: 'expired' },
  ]);
  expect(check.signIn).toBe('expired');
});

test('an expired sign-in cookie that can’t reach the music site is just missing', () => {
  expect(
    checkPastedCookies(
      `[{"domain": "www.${site}", "hostOnly": true, "name": "SAPISID", "value": "s", "path": "/", "expirationDate": 999}]`,
      1000,
    ).signIn,
  ).toBe('no');
});

test('a cookie Chromium would refuse is skipped before it can replace any', () => {
  const check = checkPastedCookies(
    `[
      {"domain": "music.${site}", "hostOnly": true, "name": "SAPISID", "value": "a\\nb", "path": "/"},
      {"domain": ".${site}", "name": "A=B", "value": "x", "path": "/"},
      {"domain": ".${site}", "name": "TAB", "value": "a\\tb", "path": "/"},
      {"domain": ".${site}", "name": "SAPISID", "value": " s", "path": "/"},
      {"domain": ".${site}", "name": "SAPISID", "value": "${'é'.repeat(2045)}", "path": "/"}
    ]`,
  );
  expect(check.skipped).toEqual([
    { entry: 1, name: 'SAPISID', reason: 'malformed' },
    { entry: 2, name: 'A=B', reason: 'malformed' },
    { entry: 4, name: 'SAPISID', reason: 'malformed' },
    { entry: 5, name: 'SAPISID', reason: 'malformed' },
  ]);
  expect(check.cookies.map(({ name }) => name)).toEqual(['TAB']);
  expect(check.signIn).toBe('no');
  expect(checkPastedCookies('SAPISID=a\u0001b; OK=1').skipped).toEqual([
    { entry: 1, reason: 'malformed' },
  ]);
});

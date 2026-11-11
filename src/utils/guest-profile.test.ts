import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import {
  accountArgs,
  createGuestProfile,
  guestArgs,
  guestTitle,
  removeGuestProfiles,
} from './guest-profile';

const scratch = () => mkdtempSync(path.join(tmpdir(), 'guest-profile-test-'));

test('a guest profile is private and holds only config.json', () => {
  const root = scratch();
  const account = path.join(root, 'account');
  mkdirSync(path.join(account, 'Local Storage'), { recursive: true });
  writeFileSync(path.join(account, 'config.json'), '{"plugins":{}}');
  writeFileSync(path.join(account, 'Cookies'), 'secret');
  writeFileSync(path.join(account, 'Local Storage', 'leveldb'), 'secret');

  const guest = createGuestProfile(root, account);

  expect(path.dirname(guest)).toBe(root);
  expect(path.basename(guest)).toMatch(/^rien-guest-/);
  if (process.platform !== 'win32') {
    expect(statSync(guest).mode & 0o777).toBe(0o700);
  }
  expect(readdirSync(guest)).toEqual(['config.json']);
  expect(readFileSync(path.join(guest, 'config.json'), 'utf8')).toBe(
    '{"plugins":{}}',
  );
  rmSync(root, { recursive: true });
});

test('an account without config.json gets an empty guest profile', () => {
  const root = scratch();
  const guest = createGuestProfile(root, path.join(root, 'missing'));
  expect(readdirSync(guest)).toEqual([]);
  const broken = path.join(root, 'broken');
  mkdirSync(broken);
  writeFileSync(path.join(broken, 'config.json'), '{"plugins":');
  expect(readdirSync(createGuestProfile(root, broken))).toEqual([]);
  rmSync(root, { recursive: true });
});

test("a guest gets the account's settings without its scrobbler sign-ins", () => {
  const root = scratch();
  const account = path.join(root, 'account');
  mkdirSync(account);
  const scrobblers = {
    lastfm: { enabled: true, token: 't', sessionKey: 's', apiKey: 'k' },
    listenbrainz: { enabled: true, token: 'l' },
  };
  writeFileSync(
    path.join(account, 'config.json'),
    JSON.stringify({
      options: { language: 'de' },
      plugins: {
        'scrobbler': { enabled: true, scrobblers },
        'api-server': { enabled: true, secret: 'x' },
      },
    }),
  );

  const guest = createGuestProfile(root, account);

  expect(
    JSON.parse(readFileSync(path.join(guest, 'config.json'), 'utf8')),
  ).toEqual({
    options: { language: 'de' },
    plugins: {
      'scrobbler': {
        enabled: false,
        scrobblers: {
          lastfm: { enabled: true, apiKey: 'k' },
          listenbrainz: { enabled: true },
        },
      },
      'api-server': { enabled: true, secret: 'x' },
    },
  });
  rmSync(root, { recursive: true });
});

test("an account's leftover guest profiles are removed, other entries stay", () => {
  const root = scratch();
  const account = path.join(root, 'account');
  const leftover = createGuestProfile(root, account);
  const otherGuest = createGuestProfile(root, path.join(root, 'other-account'));
  writeFileSync(path.join(leftover, 'Cookies'), 'guest');
  const target = path.join(root, 'other');
  mkdirSync(target);
  const link = `${createGuestProfile(root, account)}-link`;
  if (process.platform !== 'win32') symlinkSync(target, link);

  removeGuestProfiles(root, account);

  expect(existsSync(leftover)).toBe(false);
  expect(existsSync(otherGuest)).toBe(true);
  expect(existsSync(target)).toBe(true);
  if (process.platform !== 'win32') expect(existsSync(link)).toBe(true);
  rmSync(root, { recursive: true });
});

test('relaunch arguments replace the profile switches', () => {
  const args = ['--no-sandbox', '--user-data-dir=/old', '--rien-guest=/old'];
  expect(guestArgs(args, '/tmp/rien-guest-1', '/account')).toEqual([
    '--no-sandbox',
    '--user-data-dir=/tmp/rien-guest-1',
    '--rien-guest=/account',
  ]);
  expect(accountArgs(args, '/account')).toEqual([
    '--no-sandbox',
    '--user-data-dir=/account',
  ]);
});

test('the guest title keeps the page title after it', () => {
  expect(guestTitle('Rien — Guest', '')).toBe('Rien — Guest');
  expect(guestTitle('Rien — Guest', 'Music')).toBe('Rien — Guest — Music');
});

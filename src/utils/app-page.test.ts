import { test, expect } from '@playwright/test';

import { isAppPage } from './app-page';

const check = (url: string) => isAppPage(new URL(url));

test('the music site, Google pages and local files are app pages', () => {
  expect(
    check('https://music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com/watch'),
  ).toBe(true);
  expect(
    check('https://consent.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com/'),
  ).toBe(true);
  expect(check('https://accounts.google.com/ServiceLogin')).toBe(true);
  expect(check('file:///app/assets/error.html')).toBe(true);
});

test('other sites are not app pages', () => {
  expect(check('https://example.com/')).toBe(false);
  expect(check('https://google.com.example.com/')).toBe(false);
  expect(check('https://notgoogle.com/')).toBe(false);
  expect(check('http://accounts.google.com/')).toBe(false);
});

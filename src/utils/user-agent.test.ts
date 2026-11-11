import { test, expect } from '@playwright/test';

import { browserUserAgent } from './user-agent';

const chrome =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.80 Safari/537.36';

test("the app's user agent becomes Chrome's", () => {
  expect(
    browserUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Rien/3.15.0 Chrome/156.0.8078.80 Electron/45.2.3 Safari/537.36',
    ),
  ).toBe(chrome);
  // An app name with a space
  expect(
    browserUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Some App/1.0 Chrome/156.0.8078.80 Electron/45.2.3 Safari/537.36',
    ),
  ).toBe(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.80 Safari/537.36',
  );
  expect(browserUserAgent(chrome)).toBe(chrome);
});

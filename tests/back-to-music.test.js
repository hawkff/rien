import path from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';

const appPath = path.resolve(import.meta.dirname, '..');

// Google's "unusual traffic" page as the test serves it, with its captcha box
// in the top-left corner
const sorryPage = `<!doctype html><title>Sorry</title>
<body style="margin: 0; padding: 20px; font: 18px arial, sans-serif">
<div id="captcha" style="width: 302px; height: 76px; border: 1px solid #ccc">I'm not a robot</div>
<p>Our systems have detected unusual traffic from your computer network.</p>`;

test('The "Back to music" button leaves the top of other pages free', async () => {
  test.setTimeout(120_000);

  const app = await electron.launch({
    cwd: appPath,
    args: [
      appPath,
      `--user-data-dir=${test.info().outputPath('profile')}`,
      '--no-sandbox',
      '--disable-gpu',
      '--whitelisted-ips=',
      '--disable-dev-shm-usage',
    ],
  });
  try {
    const window = await app.firstWindow();
    await window.route('https://www.google.com/sorry/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: sorryPage }),
    );
    await window.goto('https://www.google.com/sorry/index');

    const button = window.locator('[data-back-to-music] button');
    await expect(button).toBeVisible({ timeout: 30_000 });
    const own = await button.boundingBox();
    const captcha = await window.locator('#captcha').boundingBox();
    expect(own.y + own.height).toBeLessThanOrEqual(captcha.y);

    // A click on the captcha's corner reaches the captcha
    const reached = await window.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.id,
      [captcha.x + 10, captcha.y + 5],
    );
    expect(reached).toBe('captcha');
  } finally {
    await app.close();
  }
});

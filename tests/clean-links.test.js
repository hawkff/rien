import path from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';

const appPath = path.resolve(import.meta.dirname, '..');
const music = 'https://music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com';

test('Links to the site lose their tracking when the page copies them', async () => {
  test.setTimeout(120_000);

  const userData = test.info().outputPath('profile');
  const app = await electron.launch({
    cwd: appPath,
    args: [
      appPath,
      `--user-data-dir=${userData}`,
      '--no-sandbox',
      '--disable-gpu',
      '--whitelisted-ips=',
      '--disable-dev-shm-usage',
    ],
  });
  try {
    const window = await app.firstWindow();
    await window.waitForURL(/^https:\/\//, { timeout: 60_000 });
    await window.waitForLoadState('domcontentloaded');
    await window.bringToFront();
    const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());

    // As Share > Copy link does it: the link selected in its box, then the
    // copy command
    const copy = (text) =>
      window.evaluate((value) => {
        const box = Object.assign(document.createElement('input'), { value });
        document.body.append(box);
        box.select();
        document.execCommand('copy');
        box.remove();
      }, text);
    await copy(`${music}/watch?v=5NV6Rdv1a3I&si=u79_UAffxWeqwSrg&drli=1`);
    expect(await clipboard()).toBe(`${music}/watch?v=5NV6Rdv1a3I`);
    // Other text goes as it is
    await copy(`Listen: ${music}/watch?v=5NV6Rdv1a3I&si=x`);
    expect(await clipboard()).toBe(`Listen: ${music}/watch?v=5NV6Rdv1a3I&si=x`);

    await window.evaluate(
      (text) => navigator.clipboard.writeText(text),
      `${music}/playlist?list=PLx&si=abc`,
    );
    expect(await clipboard()).toBe(`${music}/playlist?list=PLx`);
  } finally {
    await app.close();
  }
});

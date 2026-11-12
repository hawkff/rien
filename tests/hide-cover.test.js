import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';

const appPath = path.resolve(import.meta.dirname, '..');

test('Hide Cover hides the cover in Song mode only, and the player keeps playing', async () => {
  test.setTimeout(240_000);

  // A profile of its own that starts in Song mode with Hidden chosen
  const userData = test.info().outputPath('profile');
  mkdirSync(userData, { recursive: true });
  writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      plugins: {
        'ambient-mode': { enabled: true },
        'hide-cover': { enabled: true, mode: 'hidden' },
        'video-toggle': { enabled: true, hideVideo: true },
      },
    }),
  );

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
    await window.setViewportSize({ width: 1418, height: 842 });
    await window.goto(
      'https://music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com/watch?v=5NV6Rdv1a3I',
    );

    // Where the site asks for consent first, answer, and it goes on to the song.
    const consent = window
      .locator(
        "form[action='https://consent.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com/save'] button",
      )
      .first();
    if (await consent.isVisible()) await consent.click();

    // Playing, past any ad
    await window.waitForSelector('#movie_player', {
      state: 'attached',
      timeout: 60_000,
    });
    await expect
      .poll(
        () =>
          window.evaluate(() => {
            document
              .querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern')
              ?.click();
            const player = document.querySelector('#movie_player');
            if (player.getPlayerState() !== 1) player.playVideo();
            return (
              player.getPlayerState() === 1 &&
              !player.classList.contains('ad-showing')
            );
          }),
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe(true);

    const page = () =>
      window.evaluate(() => {
        const box = (selector) =>
          document.querySelector(selector)?.getBoundingClientRect();
        const cover = document.querySelector('#song-image > yt-img-shadow');
        return {
          song: document.body.hasAttribute('hide-cover-song'),
          column: Math.round(box('#main-panel').height),
          // The page centers the video with this padding, measured from the column
          padding: getComputedStyle(document.querySelector('#main-panel'))
            .paddingLeft,
          sidePanel: Math.round(box('#side-panel').width),
          pageWidth: Math.round(box('#main-panel').width),
          switchShown: box('.video-switch-button')?.height > 0,
          coverShown: getComputedStyle(cover).visibility === 'visible',
          time: document.querySelector('#movie_player').getCurrentTime(),
        };
      });
    // A real click, so the switch has to be reachable on the strip
    const switchMode = () =>
      window.locator('.video-switch-button-checkbox').click();

    // Hidden: the column is a strip with the switch, the side panel takes the
    // width, and the song plays on
    await expect
      .poll(async () => {
        const { song, column, switchShown } = await page();
        return { song, column, switchShown };
      })
      .toEqual({ song: true, column: 72, switchShown: true });
    const hidden = await page();
    expect(hidden.sidePanel).toBe(hidden.pageWidth);
    await expect
      .poll(async () => (await page()).time)
      .toBeGreaterThan(hidden.time + 1);

    // Video mode is untouched, sized from the full column, and plays on; back
    // in Song mode Hidden applies again
    await switchMode();
    await expect
      .poll(async () => {
        const { song, column, padding } = await page();
        return { song, wide: column > 72, padding };
      })
      .toEqual({ song: false, wide: true, padding: '0px' });
    const video = await page();
    await expect
      .poll(async () => (await page()).time)
      .toBeGreaterThan(video.time + 1);
    await switchMode();
    await expect
      .poll(async () => {
        const { song, column } = await page();
        return { song, column };
      })
      .toEqual({ song: true, column: 72 });

    // Black keeps the column with the cover out of sight; off shows it again
    const setConfig = (config) =>
      window.evaluate(
        (config) =>
          window.ipcRenderer.invoke('peard:set-config', 'hide-cover', config),
        config,
      );
    await setConfig({ mode: 'black' });
    await expect
      .poll(async () => {
        const { column, coverShown } = await page();
        return { wide: column > 72, coverShown };
      })
      .toEqual({ wide: true, coverShown: false });
    await setConfig({ enabled: false });
    await expect
      .poll(async () => {
        const { song, coverShown } = await page();
        return { song, coverShown };
      })
      .toEqual({ song: false, coverShown: true });
  } finally {
    await app.close();
  }
});

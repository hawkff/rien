import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';

const appPath = path.resolve(import.meta.dirname, '..');
// The bar at the bottom of the window. The player page holds a second
// ytmusic-miniplayer as its top bar, first in the document.
const bar = 'ytmusic-app-layout > ytmusic-miniplayer';

test('The newer player bar takes the page background and follows commands from outside the page', async () => {
  test.setTimeout(240_000);

  // The site builds the newer player bar (ytmusic-miniplayer) for some
  // profiles only, chosen by an experiment flag. The app's Newer player bar
  // option sets it.
  const profile = test.info().outputPath('profile');
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    path.join(profile, 'config.json'),
    JSON.stringify({ options: { newerPlayerBar: true } }),
  );
  const app = await electron.launch({
    cwd: appPath,
    args: [
      appPath,
      `--user-data-dir=${profile}`,
      '--no-sandbox',
      '--disable-gpu',
      '--whitelisted-ips=',
      '--disable-dev-shm-usage',
    ],
  });
  try {
    const window = await app.firstWindow();
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
    // A narrow window hides the bar while the player page is open
    await window.waitForSelector(bar, { state: 'attached', timeout: 60_000 });

    // The bar has the page's background
    await expect
      .poll(() =>
        window.evaluate((bar) => {
          const [own, page] = [document.querySelector(bar), document.body].map(
            (element) => getComputedStyle(element).backgroundColor,
          );
          return own === page;
        }, bar),
      )
      .toBe(true);

    // Playing, past any ad. In a narrow window the bar leaves out most of its
    // buttons, Previous and Repeat among them.
    await window.setViewportSize({ width: 545, height: 700 });
    const playing = () =>
      expect
        .poll(
          () =>
            window.evaluate(() => {
              document
                .querySelector(
                  '.ytp-skip-ad-button, .ytp-ad-skip-button-modern',
                )
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
    await playing();

    // The commands that the tray, the shortcuts plugin and the API server send
    const send = (channel, ...args) =>
      app.evaluate(
        ({ BrowserWindow }, [channel, args]) =>
          BrowserWindow.getAllWindows()[0].webContents.send(channel, ...args),
        [channel, args],
      );
    const state = () =>
      window.evaluate(() => {
        const { queue, player } = document
          .querySelector('#queue')
          .queue.store.store.getState();
        const api = document.querySelector('#movie_player');
        return {
          repeat: queue.repeatMode,
          shuffle: queue.shuffleEnabled,
          muted: [api.isMuted(), player.muted],
          volume: api.getVolume(),
          video: api.getVideoData().video_id,
        };
      });

    await send('peard:switch-repeat', 1);
    await expect.poll(async () => (await state()).repeat).toBe('ALL');
    // Back to NONE: with ALL, Next would go round the one song in the queue
    await send('peard:switch-repeat', 2);
    await expect.poll(async () => (await state()).repeat).toBe('NONE');

    await send('peard:shuffle');
    await expect.poll(async () => (await state()).shuffle).toBe(true);

    await send('peard:toggle-mute');
    await expect.poll(async () => (await state()).muted).toEqual([true, true]);
    await send('peard:toggle-mute');
    await expect
      .poll(async () => (await state()).muted)
      .toEqual([false, false]);
    // A volume of 0 mutes, and unmuting brings back the volume before it
    await send('peard:update-volume', 0);
    await expect.poll(async () => (await state()).muted).toEqual([true, true]);
    await send('peard:toggle-mute');
    await expect
      .poll(async () => {
        const { muted, volume } = await state();
        return [...muted, volume > 0];
      })
      .toEqual([false, false, true]);

    // Without the bar's Previous button, the command goes to the player
    await expect(
      window.locator(`${bar} [client-ve-type="36840"] button`),
    ).toHaveCount(0);
    const { video } = await state();
    await send('peard:next-video');
    await expect
      .poll(async () => (await state()).video, { timeout: 30_000 })
      .not.toBe(video);
    await send('peard:previous-video');
    await expect
      .poll(async () => (await state()).video, { timeout: 30_000 })
      .toBe(video);

    // A wide window has the bar's own Previous and Next buttons
    await window.setViewportSize({ width: 1418, height: 842 });
    await window.waitForSelector(`${bar} [client-ve-type="36840"] button`, {
      timeout: 30_000,
    });
    await send('peard:next-video');
    await expect
      .poll(async () => (await state()).video, { timeout: 30_000 })
      .not.toBe(video);
    await send('peard:previous-video');
    await expect
      .poll(async () => (await state()).video, { timeout: 30_000 })
      .toBe(video);

    // A click just under the 3 px seek line seeks, as on the older bar, and
    // doesn't reach the bar, which would close the player page. A click just
    // above it seeks too, instead of reaching the page under it.
    await playing();
    const pageOpen = () =>
      window.evaluate(() =>
        document
          .querySelector('ytmusic-app-layout')
          .hasAttribute('player-page-open'),
      );
    const seekedTo = (fraction) =>
      expect
        .poll(() =>
          window.evaluate((fraction) => {
            const { currentTime, duration } = document.querySelector('video');
            return Math.abs(currentTime / duration - fraction) < 0.05;
          }, fraction),
        )
        .toBe(true);
    expect(await pageOpen()).toBe(true);
    // The line lies on the bar's top edge, 3 px tall
    const { x, y, width } = await window.locator(bar).boundingBox();
    await window.mouse.click(x + width * 0.25, y + 6);
    await seekedTo(0.25);
    await window.mouse.click(x + width * 0.35, y - 6);
    await seekedTo(0.35);
    expect((await state()).video).toBe(video);
    expect(await pageOpen()).toBe(true);
  } finally {
    await app.close();
  }
});

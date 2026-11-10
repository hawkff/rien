import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';

const appPath = path.resolve(import.meta.dirname, '..');

// The lyrics that the test answers a lyrics search with, and their
// romanization
const lines = [
  ['夜空に星が輝いている', 'yozora ni hoshi ga kagayai te iru'],
  ['사랑해요 여러분', 'saranghaeyo yeoreobun'],
];
const syncedLyrics = lines
  .map(([line], index) => `[00:0${5 + index * 4}.00]${line}`)
  .join('\n');

test('The lyrics tab shows one list, with Japanese and Korean lines romanized', async () => {
  test.setTimeout(180_000);

  // A profile of its own, so the test neither reads nor changes the user's
  const userData = test.info().outputPath('profile');
  mkdirSync(userData, { recursive: true });
  writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      plugins: {
        'synced-lyrics': {
          enabled: true,
          romanization: true,
          preferredProvider: 'LRCLib',
        },
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

    await window.route('https://lrclib.net/**', (route) => {
      const { searchParams } = new URL(route.request().url());
      const artistName = searchParams.get('artist_name') ?? '';
      const trackName =
        searchParams.get('track_name') ?? searchParams.get('q') ?? '';
      // The provider takes the result closest to the song's duration, so
      // there is one for every ten seconds.
      const results = Array.from({ length: 91 }, (_, index) => ({
        id: index,
        name: trackName,
        trackName,
        artistName,
        albumName: '',
        duration: index * 10,
        instrumental: false,
        plainLyrics: lines.map(([line]) => line).join('\n'),
        syncedLyrics,
      }));
      return route.fulfill({
        json: results,
        headers: { 'access-control-allow-origin': '*' },
      });
    });

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

    // The tab can be clicked before the page is ready for it, so try again
    // until the lyrics are there.
    const lyricsTab = window.locator(
      '#tabsContent > .tab-header:nth-of-type(2)',
    );
    const container = window.locator('#synced-lyrics-container');
    await expect(async () => {
      await lyricsTab.click({ timeout: 2000 });
      await expect(container).toHaveCount(1, { timeout: 2000 });
    }).toPass({ timeout: 90_000 });

    for (const [line, romanized] of lines) {
      await expect(
        container.locator('.synced-line', { hasText: line }).locator('.romaji'),
      ).toHaveText(romanized, { timeout: 60_000 });
    }
    await expect(container).toHaveCount(1);
  } finally {
    await app.close();
  }
});

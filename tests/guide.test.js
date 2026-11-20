import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { test, expect, _electron as electron } from '@playwright/test';

const appPath = path.resolve(import.meta.dirname, '..');

// Signed out, the guide has no playlists, so the test answers the page's guide
// request the way it is answered signed in: Home, Explore and Library, then the
// account's playlists. The library's playlists page has covers for all of them
// but Episodes for Later. Titles, IDs and covers are made up.
const playlists = [
  {
    id: 'LM',
    title: 'Liked Music',
    subtitle: 'Auto playlist',
    color: '#c0392b',
  },
  {
    id: 'PLtest0001aaaa',
    title: 'Night Drive',
    subtitle: 'Test User',
    color: '#2980b9',
  },
  {
    id: 'PLtest0002bbbb',
    title: 'Rainy Mornings',
    subtitle: 'Test User',
    color: '#27ae60',
  },
  { id: 'SE', title: 'Episodes for Later', subtitle: 'Auto playlist' },
  {
    id: 'PLtest0003cccc',
    title: 'Late Shift',
    subtitle: 'Test User',
    color: '#8e44ad',
  },
];
const cover = (color) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="226" height="226"><rect width="226" height="226" fill="${color}"/></svg>`,
  )}`;

const runs = (text) => ({ runs: [{ text }] });
const playlistPage = {
  browseEndpointContextSupportedConfigs: {
    browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_PLAYLIST' },
  },
};
const tab = (browseId, iconType, title) => ({
  guideEntryRenderer: {
    navigationEndpoint: { browseEndpoint: { browseId } },
    icon: { iconType },
    formattedTitle: runs(title),
    accessibility: { accessibilityData: { label: title } },
    isPrimary: true,
  },
});
const guide = {
  items: [
    {
      guideSectionRenderer: {
        items: [
          tab('FEmusic_home', 'TAB_HOME', 'Home'),
          tab('FEmusic_explore', 'TAB_EXPLORE', 'Explore'),
          tab('FEmusic_library_landing', 'TAB_BOOKMARK', 'Library'),
        ],
      },
    },
    {
      guideSectionRenderer: {
        header: {
          guideSectionButtonListHeaderRenderer: {
            buttons: [
              {
                buttonRenderer: {
                  style: 'STYLE_DEFAULT',
                  text: runs('New playlist'),
                  icon: { iconType: 'ADD' },
                  navigationEndpoint: { createPlaylistEndpoint: {} },
                },
              },
            ],
          },
        },
        items: playlists.map(({ id, title, subtitle }) => ({
          guideEntryRenderer: {
            navigationEndpoint: {
              browseEndpoint: { browseId: `VL${id}`, ...playlistPage },
            },
            formattedTitle: runs(title),
            formattedSubtitle: runs(subtitle),
            accessibility: { accessibilityData: { label: title } },
            entryData: { guideEntryData: { guideEntryId: id } },
          },
        })),
        handlerDatas: ['GUIDE_ACTION_ADD_TO_PLAYLISTS'],
      },
    },
  ],
};
const library = {
  contents: {
    singleColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    gridRenderer: {
                      items: [
                        {
                          musicTwoRowItemRenderer: {
                            title: runs('New playlist'),
                            navigationEndpoint: { createPlaylistEndpoint: {} },
                          },
                        },
                        ...playlists
                          .filter(({ color }) => color)
                          .map(({ id, title, color }) => ({
                            musicTwoRowItemRenderer: {
                              thumbnailRenderer: {
                                musicThumbnailRenderer: {
                                  thumbnail: {
                                    thumbnails: [
                                      {
                                        url: cover(color),
                                        width: 226,
                                        height: 226,
                                      },
                                    ],
                                  },
                                },
                              },
                              title: runs(title),
                              navigationEndpoint: {
                                browseEndpoint: {
                                  browseId: `VL${id}`,
                                  ...playlistPage,
                                },
                              },
                            },
                          })),
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

test('A click on the guide empty space folds it, and the folded guide shows the playlists as covers', async () => {
  test.setTimeout(180_000);

  const profile = test.info().outputPath('profile');
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
    let libraryRequests = 0;
    await window.route(/\/v1\/guide\b/, (route) =>
      route.fulfill({ json: guide }),
    );
    // The page compresses larger request bodies
    const body = (request) =>
      request.headers()['content-encoding'] === 'gzip'
        ? gunzipSync(request.postDataBuffer()).toString()
        : request.postData();
    // Explore: the first request is refused after 3 s, later ones pass
    let exploreRequests = 0;
    await window.route(/\/v1\/browse\b/, async (route) => {
      const { browseId } = JSON.parse(body(route.request()));
      if (browseId === 'FEmusic_explore') {
        exploreRequests++;
        if (exploreRequests > 1) return route.fulfill({ json: {} });
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return route
          .fulfill({
            status: 403,
            contentType: 'text/html',
            body: '<title>Sorry...</title>',
          })
          .catch(() => {});
      }
      if (browseId !== 'FEmusic_liked_playlists') return route.fallback();
      libraryRequests++;
      // Rien's mark on its own read stays in the app
      expect(route.request().url()).not.toContain('rien-api-read');
      return route.fulfill({ json: library });
    });
    // Signed out, New playlist goes to the sign-in page; 204 keeps the page.
    await window.route('https://accounts.google.com/**', (route) =>
      route.fulfill({ status: 204 }),
    );

    await window.setViewportSize({ width: 1418, height: 842 });
    await window.goto(
      'https://music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com/',
    );
    const consent = window
      .locator(
        "form[action='https://consent.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com/save'] button",
      )
      .first();
    if (await consent.isVisible()) await consent.click();
    // The first guide comes with the page, and the site's refresh answers from
    // it for a while too before it asks the network.
    const expanded = window.locator('#guide-renderer');
    const playlistSection = expanded.locator(
      'ytmusic-guide-section-renderer:not([is-primary])',
    );
    await expect(async () => {
      await window.evaluate(() =>
        document.querySelector('ytmusic-app')?.fetchTabsData(),
      );
      await expect(
        playlistSection.locator('ytmusic-guide-entry-renderer'),
      ).toHaveCount(playlists.length, { timeout: 2000 });
    }).toPass({ timeout: 60_000 });
    const collapsed = () =>
      window.evaluate(
        () => document.querySelector('ytmusic-app').guideCollapsed,
      );
    expect(await collapsed()).toBe(false);
    // Nothing asks for covers while the guide is open
    expect(libraryRequests).toBe(0);
    // The empty band under Library
    const primary = await expanded
      .locator('ytmusic-guide-section-renderer[is-primary]')
      .boundingBox();
    const emptyY = primary.y + primary.height - 4;

    // An entry, the New playlist button, a drag over empty space, a press on
    // an entry released just below it and a right click leave the guide open.
    await playlistSection.getByRole('link', { name: 'Night Drive' }).click();
    await expect(window).toHaveURL(/list=PLtest0001aaaa/);
    await playlistSection.getByRole('button', { name: 'New playlist' }).click();
    const drag = async ([fromX, fromY], [toX, toY]) => {
      await window.mouse.move(fromX, fromY);
      await window.mouse.down();
      await window.mouse.move(toX, toY, { steps: 3 });
      await window.mouse.up();
    };
    await drag([40, emptyY], [180, emptyY]);
    const lastEntry = await playlistSection
      .locator('ytmusic-guide-entry-renderer')
      .last()
      .boundingBox();
    const entryBottom = lastEntry.y + lastEntry.height - 1;
    await drag([120, entryBottom], [120, entryBottom + 3]);
    await window.mouse.click(120, emptyY, { button: 'right' });
    await window.waitForTimeout(500);
    expect(await collapsed()).toBe(false);

    // A click in the empty space folds the guide, as the menu button does.
    // The covers' request doesn't take the tries of the page's own browse
    // request that is under way: refused once, it still gets its answer.
    const explore = window.evaluate(() =>
      document
        .querySelector('ytmusic-app')
        .networkManager.fetch('/browse', { browseId: 'FEmusic_explore' })
        .then(
          () => 'answered',
          () => 'failed',
        ),
    );
    await window.waitForTimeout(300);
    await window.mouse.click(120, emptyY);
    await expect.poll(collapsed).toBe(true);
    expect(await explore).toBe('answered');
    expect(exploreRequests).toBe(2);
    await expect(
      window.locator('ytmusic-nav-bar #guide-button button'),
    ).toHaveAttribute('aria-pressed', 'false');

    // The folded guide lists the playlists, in order, with their names and covers
    const mini = window.locator(
      '#mini-guide-renderer ytmusic-guide-section-renderer:not([is-primary]) tp-yt-paper-item',
    );
    await expect(mini).toHaveCount(playlists.length);
    for (const [index, { title, color }] of playlists.entries()) {
      const item = mini.nth(index);
      await expect(item).toBeVisible();
      await expect(item).toHaveAttribute('title', title);
      await expect(item).toHaveAccessibleName(title);
      const background = () =>
        item.evaluate((e) => getComputedStyle(e, '::after').backgroundImage);
      if (color) {
        await expect.poll(background).toContain(encodeURIComponent(color));
      } else {
        await expect.poll(background).toMatch(/^none, url\("data:image\/svg/);
      }
    }
    expect(libraryRequests).toBe(1);
    // The open playlist is marked
    await expect(
      window.locator(
        '#mini-guide-renderer ytmusic-guide-entry-renderer[active]',
      ),
    ).toHaveText(/Night Drive/);

    // A cover opens its playlist in the page, without a reload
    await window.evaluate(() => {
      window.notReloaded = true;
    });
    await window
      .locator('#mini-guide-renderer')
      .getByRole('link', { name: 'Rainy Mornings' })
      .click();
    await expect(window).toHaveURL(/list=PLtest0002bbbb/);
    expect(await window.evaluate(() => window.notReloaded)).toBe(true);
    expect(await collapsed()).toBe(true);

    // In a low window the list scrolls inside the bar, and the page stays
    await window.setViewportSize({ width: 1418, height: 420 });
    await expect(mini.last()).not.toBeInViewport();
    await mini.first().hover();
    await window.mouse.wheel(0, 600);
    await expect(mini.last()).toBeInViewport();
    expect(await window.evaluate(() => window.scrollY)).toBe(0);
    await mini.last().click();
    await expect(window).toHaveURL(/list=PLtest0003cccc/);
    await window.setViewportSize({ width: 1418, height: 842 });

    // A click in the folded guide's empty space opens it again
    const last = await mini.last().boundingBox();
    await window.mouse.click(36, last.y + last.height + 40);
    await expect.poll(collapsed).toBe(false);
    expect(libraryRequests).toBe(1);
  } finally {
    await app.close();
  }
});

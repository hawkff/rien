import { waitForElement } from '@/utils/wait-for-element';

import { apiServerRead } from './retry-blocked';

import type { MusicPlayerAppElement } from '@/types/music-player-app-element';

type Endpoint = { browseEndpoint?: { browseId?: string } };
type GuideEntry = HTMLElement & {
  data?: {
    navigationEndpoint?: Endpoint;
    formattedTitle?: { runs?: { text: string }[] };
  };
};
type LibraryPlaylists = {
  contents?: {
    singleColumnBrowseResultsRenderer?: {
      tabs?: {
        tabRenderer?: {
          content?: {
            sectionListRenderer?: {
              contents?: {
                gridRenderer?: {
                  items?: {
                    musicTwoRowItemRenderer?: {
                      navigationEndpoint?: Endpoint;
                      thumbnailRenderer?: {
                        musicThumbnailRenderer?: {
                          thumbnail?: { thumbnails?: { url: string }[] };
                        };
                      };
                    };
                  }[];
                };
              }[];
            };
          };
        };
      }[];
    };
  };
};

// A click on the guide's empty space does what the site's menu button does.
// Only while the guide stays beside the page: in a narrow window it opens over
// the page as a drawer, and that keeps the site's behavior.
const isEmptySpace = (event: MouseEvent) => {
  const target = event.target as Element;
  if (
    !target.closest('tp-yt-app-drawer#guide, #mini-guide') ||
    target.closest(
      'ytmusic-guide-entry-renderer, ytmusic-guide-signin-promo-renderer, a, button, input, [role="button"], [role="link"]',
    )
  ) {
    return false;
  }
  // A press on a scrollbar
  const box = target.getBoundingClientRect();
  return !(
    target.scrollHeight > target.clientHeight &&
    event.clientX - box.left - target.clientLeft >= target.clientWidth
  );
};

const toggleOnEmptyClick = (layout: HTMLElement) => {
  // Both ends of the click count: a press on an entry released just beside it
  // clicks the space around them.
  let pressed: PointerEvent | undefined;
  layout.addEventListener('pointerdown', (event) => {
    pressed = event.button === 0 && isEmptySpace(event) ? event : undefined;
  });
  layout.addEventListener('click', (event) => {
    const press = pressed;
    pressed = undefined;
    if (
      press &&
      event.button === 0 &&
      isEmptySpace(event) &&
      layout.querySelector('tp-yt-app-drawer#guide[persistent]') &&
      !getSelection()?.toString() &&
      Math.hypot(
        event.clientX - press.clientX,
        event.clientY - press.clientY,
      ) <= 4
    ) {
      document
        .querySelector<HTMLElement>('ytmusic-nav-bar #guide-button')
        ?.click();
    }
  });
};

// The collapsed guide shows the account's playlists as covers. The site renders
// the playlist entries there too, hidden, and keeps their order, navigation and
// active mark; the guide's data has no covers, the library's playlists do.
const covers = new Map<string, string>();
let coversAskedFor = '';

const browseIdOf = (entry: GuideEntry) =>
  entry.data?.navigationEndpoint?.browseEndpoint?.browseId ?? '';

const fetchCovers = async () => {
  const app = document.querySelector<MusicPlayerAppElement>('ytmusic-app');
  // shortcut: the first page of the library's playlists only, later ones keep
  // the playlist icon; follow its continuation when that matters.
  // Marked as Rien's own read: it keeps its tries, and the page's browse
  // requests keep theirs.
  const page = await app?.networkManager
    .fetch<LibraryPlaylists, { browseId: string }>(`/browse?${apiServerRead}`, {
      browseId: 'FEmusic_liked_playlists',
    })
    .catch(() => null);
  if (!page) return false;
  const items =
    page.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
      ?.content?.sectionListRenderer?.contents?.[0]?.gridRenderer?.items ?? [];
  for (const { musicTwoRowItemRenderer: item } of items) {
    const id = item?.navigationEndpoint?.browseEndpoint?.browseId;
    const url =
      item?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail
        ?.thumbnails?.[0]?.url;
    if (id && url) covers.set(id, url);
  }
  return true;
};

const showCovers = (miniGuide: Element) => {
  const entries = [
    ...miniGuide.querySelectorAll<GuideEntry>(
      'ytmusic-guide-section-renderer:not([is-primary]) ytmusic-guide-entry-renderer',
    ),
  ];
  for (const entry of entries) {
    const item = entry.querySelector<HTMLElement>('tp-yt-paper-item');
    const name = entry.data?.formattedTitle?.runs
      ?.map(({ text }) => text)
      .join('');
    if (item && name && item.title !== name) {
      item.title = name;
      item.setAttribute('aria-label', name);
    }
    const cover = covers.get(browseIdOf(entry));
    entry.style.setProperty(
      '--guide-cover',
      cover ? `url(${JSON.stringify(cover)})` : null,
    );
  }
  // Asked again when the list changes and holds a playlist without a cover
  const ids = entries.map(browseIdOf).join();
  if (
    ids !== coversAskedFor &&
    entries.some((entry) => !covers.has(browseIdOf(entry)))
  ) {
    coversAskedFor = ids;
    fetchCovers().then((fetched) => {
      if (fetched) showCovers(miniGuide);
      // A failed request is sent again on the guide's next change
      else coversAskedFor = '';
    });
  }
};

export const setupGuide = async () => {
  const layout = document.querySelector<HTMLElement>('ytmusic-app-layout');
  if (!layout) return;
  toggleOnEmptyClick(layout);
  const miniGuide = await waitForElement('#mini-guide-renderer', {
    retryInterval: 500,
  });
  new MutationObserver(() => showCovers(miniGuide)).observe(miniGuide, {
    childList: true,
    subtree: true,
  });
  showCovers(miniGuide);
};

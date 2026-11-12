import i18next from 'i18next';
import { setTheme } from 'mdui/functions/setTheme.js';
import 'mdui/mdui.css';
import 'mdui';

import { loadI18n, setLanguage, t as i18t } from '@/i18n';
import { LoggerPrefix } from '@/utils';
import {
  defaultTrustedTypePolicy,
  registerWindowDefaultTrustedTypePolicy,
} from '@/utils/trusted-types';

import {
  createContext,
  forceLoadRendererPlugin,
  forceUnloadRendererPlugin,
  getAllLoadedRendererPlugins,
  getLoadedRendererPlugin,
  loadAllRendererPlugins,
} from './loader/renderer';
import { startingPages } from './providers/extracted-data';
import {
  appStore,
  getLikeStatus,
  isFullscreen,
  playerBar,
  setFullscreen,
  setMuteAndVolume,
  skip,
  toggleMute,
} from './providers/player-bar';
import { addPlayerPageButton } from './providers/player-page-button';
import { retryBlockedRequests } from './providers/retry-blocked';
import { setupSongInfo } from './providers/song-info-front';

import type { RepeatMode } from '@/types/datahost-get-state';
import type { MusicPlayer } from '@/types/music-player';
import type { MusicPlayerAppElement } from '@/types/music-player-app-element';
import type { QueueResponse } from '@/types/music-player-desktop-internal';
import type { PluginConfig } from '@/types/plugins';
import type { QueueElement } from '@/types/queue';
import type { SearchBoxElement } from '@/types/search-box-element';

setTheme('dark');

let api: (Element & MusicPlayer) | null = null;
let isPluginLoaded = false;
let isApiLoaded = false;
let firstDataLoaded = false;

registerWindowDefaultTrustedTypePolicy();
retryBlockedRequests();
// For the API server, which reads it through executeJavaScript
window.getLikeStatus = getLikeStatus;

const onPlayerApiReady = async (
  id: string,
  plugin: NonNullable<ReturnType<typeof getLoadedRendererPlugin>>,
) => {
  if (typeof plugin.renderer === 'function') return;
  try {
    await plugin.renderer?.onPlayerApiReady?.call(
      plugin.renderer,
      api!,
      createContext(id),
    );
  } catch (error) {
    console.error(LoggerPrefix, `${id}: the player hook failed`, error);
  }
};

// The order in which the repeat button goes through the modes
const repeatModes: RepeatMode[] = ['NONE', 'ALL', 'ONE'];

async function listenForApiLoad() {
  if (!isApiLoaded) {
    api = document.querySelector('#movie_player');
    if (api) {
      await onApiLoaded();

      return;
    }
  }
}

async function onApiLoaded() {
  // Workaround for macOS traffic lights
  {
    let osType = 'Unknown';
    if (window.electronIs.osx()) {
      osType = 'Macintosh';
    } else if (window.electronIs.windows()) {
      osType = 'Windows';
    } else if (window.electronIs.linux()) {
      osType = 'Linux';
    }
    document.documentElement.setAttribute('data-os', osType);
  }

  // Workaround for #2459
  document
    .querySelector('button.video-button.ytmusic-av-toggle')
    ?.addEventListener('click', () =>
      window.dispatchEvent(new Event('resize')),
    );

  // The commands below come from outside the page: the tray, the shortcuts
  // plugin, the API server. Each works with either player bar. The newer bar
  // leaves out most of its buttons in a narrow window, so for it they go to
  // the player and the store, as the site's own controller does.
  window.ipcRenderer.on('peard:previous-video', () => {
    if (api) skip('previous', api);
  });
  window.ipcRenderer.on('peard:next-video', () => {
    if (api) skip('next', api);
  });
  window.ipcRenderer.on('peard:play', (_) => {
    api?.playVideo();
  });
  // The event the site's own links send, so the page plays without loading
  window.ipcRenderer.on(
    'peard:play-target',
    (_, watchEndpoint: { videoId?: string; playlistId?: string }) => {
      document.querySelector('ytmusic-app')?.dispatchEvent(
        new CustomEvent('yt-navigate', {
          bubbles: true,
          composed: true,
          detail: { endpoint: { watchEndpoint } },
        }),
      );
    },
  );
  window.ipcRenderer.on('peard:pause', (_) => {
    api?.pauseVideo();
  });
  window.ipcRenderer.on('peard:toggle-play', (_) => {
    if (api?.getPlayerState() === 2) api?.playVideo();
    else api?.pauseVideo();
  });
  window.ipcRenderer.on('peard:seek-to', (_, t: number) => api!.seekTo(t));
  window.ipcRenderer.on('peard:seek-by', (_, t: number) => api!.seekBy(t));
  window.ipcRenderer.on('peard:shuffle', () => {
    document.querySelector<QueueElement>('#queue')?.queue.shuffle();
  });

  const isShuffled = () => appStore()?.getState().queue.shuffleEnabled ?? false;

  window.ipcRenderer.on('peard:get-shuffle', () => {
    window.ipcRenderer.send('peard:get-shuffle-response', isShuffled());
  });

  window.ipcRenderer.on(
    'peard:update-like',
    (_, status: 'LIKE' | 'DISLIKE' = 'LIKE') => {
      const older = document.querySelector<
        HTMLElement & { updateLikeStatus: (status: string) => void }
      >('#like-button-renderer');
      if (older) {
        older.updateLikeStatus(status);
        return;
      }
      // The newer bar's buttons toggle: press the one asked for unless it is
      // pressed already.
      const button = status === 'DISLIKE' ? playerBar.dislike : playerBar.like;
      document
        .querySelector<HTMLElement>(`${button}:not([aria-pressed="true"])`)
        ?.click();
    },
  );
  window.ipcRenderer.on('peard:switch-repeat', (_, repeat = 1) => {
    for (let i = 0; i < repeat; i++) {
      const older = document.querySelector<
        HTMLElement & { onRepeatButtonClick: () => void }
      >('ytmusic-player-bar');
      if (older) {
        older.onRepeatButtonClick();
        continue;
      }
      const store = appStore();
      const mode = store?.getState().queue.repeatMode ?? 'NONE';
      store?.dispatch({
        type: 'SET_REPEAT',
        payload:
          repeatModes[(repeatModes.indexOf(mode) + 1) % repeatModes.length],
      });
    }
  });
  window.ipcRenderer.on('peard:update-volume', (_, volume: number) => {
    const older = document.querySelector<
      HTMLElement & { updateVolume: (volume: number) => void }
    >('ytmusic-player-bar');
    if (older) older.updateVolume(volume);
    else if (api) setMuteAndVolume(api, volume === 0, volume);
  });

  window.ipcRenderer.on('peard:get-fullscreen', () => {
    window.ipcRenderer.send('peard:set-fullscreen', isFullscreen());
  });

  window.ipcRenderer.on(
    'peard:click-fullscreen-button',
    (_, fullscreen: boolean | undefined) => {
      setFullscreen(fullscreen ?? false);
    },
  );

  window.ipcRenderer.on('peard:toggle-mute', (_) => {
    const older = document.querySelector<
      HTMLElement & { onVolumeClick: () => void }
    >('ytmusic-player-bar');
    if (older) older.onVolumeClick();
    else if (api) toggleMute(api);
  });

  window.ipcRenderer.on('peard:get-queue', () => {
    const queue = document.querySelector<QueueElement>('#queue');
    const state = queue?.queue.store.store.getState().queue;
    window.ipcRenderer.send('peard:get-queue-response', {
      items: queue?.queue.getItems(),
      autoPlaying: queue?.queue.autoPlaying,
      continuation: queue?.queue.continuation,
      automixItems: state?.autoplay ? state.automixItems : [],
    } satisfies QueueResponse);
  });

  window.ipcRenderer.on(
    'peard:add-to-queue',
    (_, videoIds: string | string[], queueInsertPosition: string) => {
      const queue = document.querySelector<QueueElement>('#queue');
      const app = document.querySelector<MusicPlayerAppElement>('ytmusic-app');
      if (!app) return;

      const store = queue?.queue.store.store;
      if (!store) return;

      app.networkManager
        .fetch('/music/get_queue', {
          queueContextParams: store.getState().queue.queueContextParams,
          queueInsertPosition,
          videoIds: Array.isArray(videoIds) ? videoIds : [videoIds],
        })
        .then((result) => {
          if (
            result &&
            typeof result === 'object' &&
            'queueDatas' in result &&
            Array.isArray(result.queueDatas)
          ) {
            const queueItems = store.getState().queue.items;
            const queueItemsLength = queueItems.length ?? 0;
            queue?.dispatch({
              type: 'ADD_ITEMS',
              payload: {
                nextQueueItemId: store.getState().queue.nextQueueItemId,
                index:
                  queueInsertPosition === 'INSERT_AFTER_CURRENT_VIDEO'
                    ? queueItems.findIndex(
                        (it) =>
                          (
                            it.playlistPanelVideoRenderer ||
                            it.playlistPanelVideoWrapperRenderer
                              ?.primaryRenderer.playlistPanelVideoRenderer
                          )?.selected,
                      ) + 1 || queueItemsLength
                    : queueItemsLength,
                items: result.queueDatas
                  .map((it) =>
                    typeof it === 'object' && it && 'content' in it
                      ? it.content
                      : null,
                  )
                  .filter(Boolean),
                shuffleEnabled: false,
                shouldAssignIds: true,
              },
            });
          }
        });
    },
  );
  window.ipcRenderer.on(
    'peard:move-in-queue',
    (_, fromIndex: number, toIndex: number) => {
      const queue = document.querySelector<QueueElement>('#queue');
      queue?.dispatch({
        type: 'MOVE_ITEM',
        payload: {
          fromIndex,
          toIndex,
        },
      });
    },
  );
  window.ipcRenderer.on('peard:remove-from-queue', (_, index: number) => {
    const queue = document.querySelector<QueueElement>('#queue');
    queue?.dispatch({
      type: 'REMOVE_ITEM',
      payload: index,
    });
  });
  window.ipcRenderer.on('peard:set-queue-index', (_, index: number) => {
    const queue = document.querySelector<QueueElement>('#queue');
    queue?.dispatch({
      type: 'SET_INDEX',
      payload: index,
    });
  });
  window.ipcRenderer.on('peard:clear-queue', () => {
    const queue = document.querySelector<QueueElement>('#queue');
    queue?.queue.store.store.dispatch({
      type: 'SET_PLAYER_PAGE_INFO',
      payload: { open: false },
    });
    queue?.dispatch({
      type: 'CLEAR',
    });
  });

  window.ipcRenderer.on(
    'peard:search',
    async (_, query: string, params?: string, continuation?: string) => {
      const app = document.querySelector<MusicPlayerAppElement>('ytmusic-app');
      const searchBox =
        document.querySelector<SearchBoxElement>('ytmusic-search-box');

      if (!app || !searchBox) return;

      const result = await app.networkManager.fetch<
        unknown,
        {
          query: string;
          params?: string;
          continuation?: string;
          suggestStats?: unknown;
        }
      >('/search', {
        query,
        params,
        continuation,
        suggestStats: searchBox.getSearchboxStats(),
      });

      window.ipcRenderer.send('peard:search-results', result);
    },
  );

  const video = document.querySelector('video')!;
  const audioContext = new AudioContext();
  const audioSource = audioContext.createMediaElementSource(video);
  audioSource.connect(audioContext.destination);

  // Each plugin's hook runs on its own, so one that throws, as on a page layout
  // it does not know, no longer keeps the others from starting. The rest of
  // this setup waits for all of them: hooks subscribe to the events it sends.
  await Promise.all(
    Object.entries(getAllLoadedRendererPlugins()).map(([id, plugin]) =>
      onPlayerApiReady(id, plugin),
    ),
  );
  addPlayerPageButton();

  if (firstDataLoaded) {
    document.dispatchEvent(
      new CustomEvent('videodatachange', { detail: { name: 'dataloaded' } }),
    );
  }

  const audioCanPlayEventDispatcher = () => {
    document.dispatchEvent(
      new CustomEvent('peard:audio-can-play', {
        detail: {
          audioContext,
          audioSource,
        },
      }),
    );
  };

  const loadstartListener = () => {
    // Emit "audioCanPlay" for each video
    video.addEventListener('canplaythrough', audioCanPlayEventDispatcher, {
      once: true,
    });
  };

  if (video.readyState === 4 /* HAVE_ENOUGH_DATA (loaded) */) {
    audioCanPlayEventDispatcher();
  }

  video.addEventListener('loadstart', loadstartListener, { passive: true });

  window.ipcRenderer.send('peard:player-api-loaded');

  // Navigate to "Starting page"
  const startingPage: string = window.mainConfig.get('options.startingPage');
  if (startingPage && startingPages[startingPage]) {
    document
      .querySelector<MusicPlayerAppElement>('ytmusic-app')
      ?.navigate(startingPages[startingPage]);
  }

  // Remove upgrade button
  if (window.mainConfig.get('options.removeUpgradeButton')) {
    const itemsSelector = 'ytmusic-guide-section-renderer #items';
    let selector = 'ytmusic-guide-entry-renderer:last-child';

    const upgradeBtnIcon = document.querySelector<SVGGElement>(
      'iron-iconset-svg[name="yt-sys-icons"] #\u0079\u006f\u0075\u0074\u0075\u0062\u0065_music_monochrome',
    );
    if (upgradeBtnIcon) {
      const path = upgradeBtnIcon.firstChild as SVGPathElement;
      const data = path.getAttribute('d')!.substring(0, 15);
      selector = `ytmusic-guide-entry-renderer:has(> tp-yt-paper-item > yt-icon path[d^="${data}"])`;
    }

    const styles = document.createElement('style');
    styles.textContent = `${itemsSelector} ${selector} { display: none; }`;

    document.head.appendChild(styles);
  }

  // Hide / Force show like buttons
  const likeButtonsOptions: string = window.mainConfig.get(
    'options.likeButtons',
  );
  if (likeButtonsOptions) {
    const style = document.createElement('style');
    style.textContent = `
      ytmusic-player-bar[is-mweb-player-bar-modernization-enabled] .middle-controls-buttons.ytmusic-player-bar, #like-button-renderer {
        display: ${
          likeButtonsOptions === 'hide' ? 'none' : 'inherit'
        } !important;
      }
      ytmusic-player-bar[is-mweb-player-bar-modernization-enabled] .middle-controls.ytmusic-player-bar {
        justify-content: ${
          likeButtonsOptions === 'hide' ? 'flex-start' : 'space-between'
        } !important;
      }
      ${
        likeButtonsOptions === 'hide'
          ? 'ytmusic-miniplayer yt-video-action-bar-view-model { display: none !important; }'
          : ''
      }`;

    document.head.appendChild(style);
  }

  // Swap like button order
  if (window.mainConfig.get('options.swapLikeButtonsOrder')) {
    const style = document.createElement('style');
    style.textContent = `
      #like-button-renderer {
        display: inline-flex;
        flex-direction: row-reverse;
      }`;

    document.head.appendChild(style);
  }
}

const definePearTransElements = () => {
  customElements.define(
    'pear-trans',
    class extends HTMLElement {
      connectedCallback() {
        const key = this.getAttribute('key');
        if (key) {
          const targetHtml = i18t(key);
          (this.innerHTML as string | TrustedHTML) = defaultTrustedTypePolicy
            ? defaultTrustedTypePolicy.createHTML(targetHtml)
            : targetHtml;
        }
      }
    },
  );
};

const preload = async () => {
  await loadI18n();
  await setLanguage(window.mainConfig.get('options.language') ?? 'en');
  window.i18n = {
    t: i18t.bind(i18next),
  };
  definePearTransElements();
  if (document.body?.dataset?.os) {
    document.body.dataset.os = navigator.userAgent;
  }
};

const main = async () => {
  await loadAllRendererPlugins();
  isPluginLoaded = true;

  window.ipcRenderer.on('plugin:unload', async (_event, id: string) => {
    await forceUnloadRendererPlugin(id);
  });
  window.ipcRenderer.on('plugin:enable', async (_event, id: string) => {
    await forceLoadRendererPlugin(id);
    const plugin = getLoadedRendererPlugin(id);
    if (api && plugin) await onPlayerApiReady(id, plugin);
  });

  window.ipcRenderer.on(
    'config-changed',
    (_event, id: string, newConfig: PluginConfig) => {
      const plugin = getAllLoadedRendererPlugins()[id];
      if (plugin && typeof plugin.renderer !== 'function') {
        plugin.renderer?.onConfigChange?.call(plugin.renderer, newConfig);
      }
    },
  );

  // Wait for complete load of the api
  await listenForApiLoad();

  // Blocks the "Are You Still There?" popup by setting the last active time to Date.now every 15min
  setInterval(() => (window._lact = Date.now()), 900_000);

  // Setup back to front logger
  if (window.electronIs.dev()) {
    window.ipcRenderer.on('log', (_event, log: string) => {
      console.log(JSON.parse(log));
    });
  }
};

const initObserver = async () => {
  // check document.documentElement is ready
  await new Promise<void>((resolve) => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => resolve(), {
        once: true,
      });
    } else {
      resolve();
    }
  });

  const observer = new MutationObserver(() => {
    const playerApi = document.querySelector<Element & MusicPlayer>(
      '#movie_player',
    );
    if (playerApi) {
      observer.disconnect();

      // Inject song-info provider
      setupSongInfo(playerApi);
      const dataLoadedListener = (name: string) => {
        if (!firstDataLoaded && name === 'dataloaded') {
          firstDataLoaded = true;
          playerApi.removeEventListener('videodatachange', dataLoadedListener);
        }
      };
      playerApi.addEventListener('videodatachange', dataLoadedListener);

      if (isPluginLoaded && !isApiLoaded) {
        api = playerApi;
        isApiLoaded = true;

        onApiLoaded();
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
};

initObserver().then(preload).then(main);

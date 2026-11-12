import { createRenderer } from '@/utils';
import { waitForElement } from '@/utils/wait-for-element';

import { disposeReactiveRoot } from './reactive-root';
import { setConfig, setCurrentTime } from './renderer';
import { fetchLyrics, lyricsStore } from './store';
import { selectors, tabStates } from './utils';

import type { SyncedLyricsPluginConfig } from '../types';
import type { SongInfo } from '@/providers/song-info';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

export let _ytAPI: MusicPlayer | null = null;
export let netFetch: (
  url: string,
  init?: RequestInit,
) => Promise<[number, string, Record<string, string>]>;
// These run in the native module in the main process.
export let detectLanguage: (text: string) => Promise<string | null>;
export let romanizeJapanese: (text: string) => Promise<string>;

export const renderer = createRenderer<
  {
    observerCallback: MutationCallback;
    observer?: MutationObserver;
    videoDataChange: () => Promise<void>;
    updateTimestampInterval?: NodeJS.Timeout | string | number;
  },
  SyncedLyricsPluginConfig
>({
  onConfigChange(newConfig) {
    setConfig(newConfig);
  },

  observerCallback(mutations: MutationRecord[]) {
    for (const mutation of mutations) {
      const header = mutation.target as HTMLElement;

      switch (mutation.attributeName) {
        case 'disabled':
          header.removeAttribute('disabled');
          break;
        case 'aria-selected':
          tabStates[header.ariaSelected ?? 'false']();
          break;
      }
    }
  },

  async onPlayerApiReady(api: MusicPlayer) {
    _ytAPI = api;

    api.addEventListener('videodatachange', this.videoDataChange);

    await this.videoDataChange();
  },
  async videoDataChange() {
    if (!this.updateTimestampInterval) {
      this.updateTimestampInterval = setInterval(
        () => setCurrentTime((_ytAPI?.getCurrentTime() ?? 0) * 1000),
        100,
      );
    }

    // prettier-ignore
    this.observer ??= new MutationObserver(this.observerCallback);
    this.observer.disconnect();

    // Force the lyrics tab to be enabled at all times.
    const header = await waitForElement<HTMLElement>(selectors.head);
    {
      header.removeAttribute('disabled');
      tabStates[header.ariaSelected ?? 'false']();
    }

    this.observer.observe(header, { attributes: true });
    header.removeAttribute('disabled');
  },

  async start(ctx: RendererContext<SyncedLyricsPluginConfig>) {
    netFetch = ctx.ipc.invoke.bind(ctx.ipc, 'synced-lyrics:fetch');
    detectLanguage = ctx.ipc.invoke.bind(
      ctx.ipc,
      'synced-lyrics:detect-language',
    );
    romanizeJapanese = ctx.ipc.invoke.bind(
      ctx.ipc,
      'synced-lyrics:romanize-japanese',
    );

    setConfig(await ctx.getConfig());

    ctx.ipc.on('peard:update-song-info', (info: SongInfo) => {
      fetchLyrics(info);
    });

    // For the API server. Plain copies: the store's proxies can't leave the page.
    window.getSyncedLyrics = () => {
      const { provider, current } = lyricsStore;
      if (current.state !== 'done' || !current.data) return null;
      const { title, artists, lyrics, lines } = current.data;
      return {
        provider,
        title,
        artists: [...artists],
        lines:
          lines?.map(({ timeInMs, duration, text }) => ({
            timeMs: timeInMs,
            // The last line has no end: it lasts until the song does
            durationMs: Number.isFinite(duration) ? duration : null,
            text,
          })) ?? null,
        plain: lyrics ?? null,
      };
    };
  },

  stop() {
    delete window.getSyncedLyrics;
    disposeReactiveRoot();
  },
});

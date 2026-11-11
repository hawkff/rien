import { t } from '@/i18n';
import { newerBar, playerBar } from '@/providers/player-bar';
import { createPlugin } from '@/utils';

import style from './style.css?inline';

import type { MusicPlayer } from '@/types/music-player';

// The counts come from the Return Dislike API: counts archived before the site
// hid them, and estimates from the extension's users for newer songs.
const dislikes = (videoId: string) =>
  fetch(
    `https://return\u0079\u006f\u0075\u0074\u0075\u0062\u0065dislikeapi.com/votes?videoId=${encodeURIComponent(videoId)}`,
  )
    .then(async (response) =>
      response.ok
        ? ((await response.json()) as { dislikes?: number }).dislikes
        : undefined,
    )
    .catch(() => undefined);

// The dislike button of the older player bar and of the newer one
const dislikeButton = `ytmusic-player-bar #button-shape-dislike button, ${playerBar.dislike}`;
const label = () =>
  document.querySelector<HTMLElement>(
    `ytmusic-player-bar .dislike-count, ${newerBar} .dislike-count`,
  );

export default createPlugin<
  unknown,
  unknown,
  {
    api?: MusicPlayer;
    count?: { video: string; text: string };
    loading?: string;
    observer?: MutationObserver;
    show(this: void): Promise<void>;
  }
>({
  name: () => t('plugins.return-dislike.name'),
  description: () => t('plugins.return-dislike.description'),
  restartNeeded: false,
  config: {
    enabled: false,
  },
  stylesheets: [style],
  renderer: {
    show: async () => {},
    onPlayerApiReady(api) {
      this.api = api;
      // Puts the current song's count into the dislike button, and takes an
      // earlier song's out.
      const place = () => {
        const count =
          this.count?.video === api.getVideoData().video_id
            ? this.count
            : undefined;
        const element = label();
        if (element && element.dataset.video === count?.video) return;
        element?.remove();
        if (!count) return;
        const span = Object.assign(document.createElement('span'), {
          className: 'dislike-count',
          textContent: count.text,
        });
        span.dataset.video = count.video;
        document.querySelector(dislikeButton)?.append(span);
      };
      this.show = async () => {
        const videoId = api.getVideoData().video_id;
        place();
        // The player reports each song more than once.
        if (this.count?.video === videoId || this.loading === videoId) return;
        this.loading = videoId;
        const count = await dislikes(videoId);
        if (this.loading === videoId) this.loading = undefined;
        // The answer for an earlier song can arrive after the next one started,
        // and an answer can arrive after the plugin stopped.
        if (
          count === undefined ||
          this.api !== api ||
          api.getVideoData().video_id !== videoId
        ) {
          return;
        }
        this.count = {
          video: videoId,
          text: new Intl.NumberFormat(
            document.documentElement.lang || undefined,
            { notation: 'compact' },
          ).format(count),
        };
        place();
      };
      // The player bar renders its buttons anew now and then, which drops the
      // count.
      this.observer = new MutationObserver(place);
      const bar = document.querySelector(`ytmusic-player-bar, ${newerBar}`);
      if (bar) this.observer.observe(bar, { childList: true, subtree: true });
      api.addEventListener('videodatachange', this.show);
      this.show();
    },
    stop() {
      this.observer?.disconnect();
      this.api?.removeEventListener('videodatachange', this.show);
      this.api = undefined;
      label()?.remove();
    },
  },
});

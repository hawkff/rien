import { t } from '@/i18n';
import { getLikeStatus, newerBar, skip } from '@/providers/player-bar';
import { LikeType } from '@/types/datahost-get-state';
import { createPlugin } from '@/utils';
import { waitForElement } from '@/utils/wait-for-element';

import type { MusicPlayer } from '@/types/music-player';

export default createPlugin<
  unknown,
  unknown,
  {
    observer?: MutationObserver;
    onSong?: (event: CustomEvent<{ name: string }>) => void;
    // This start's own: a stop before the bar is there drops it
    run?: object;
    onPlayerApiReady(api: MusicPlayer): void;
    stop(): void;
  }
>({
  name: () => t('plugins.skip-disliked-songs.name'),
  description: () => t('plugins.skip-disliked-songs.description'),
  restartNeeded: false,
  renderer: {
    // The older bar holds the song's rating in an attribute, the newer one in
    // its buttons' aria-pressed. A song skips once each time it plays: the
    // newer bar's buttons change more than once.
    onPlayerApiReady(api: MusicPlayer) {
      let playing: string | undefined;
      let skipped = false;
      const check = () => {
        const video = api.getVideoData()?.video_id;
        if (!video) return;
        if (video !== playing) {
          playing = video;
          skipped = false;
        }
        if (skipped || getLikeStatus() !== LikeType.Dislike) return;
        skipped = true;
        skip('next', api);
      };
      // Every song that starts may skip again, the same one played anew too
      this.onSong = ({ detail }) => {
        if (detail.name === 'dataloaded') skipped = false;
      };
      document.addEventListener('videodatachange', this.onSong);
      const run = {};
      this.run = run;
      waitForElement<HTMLElement>(`ytmusic-player-bar, ${newerBar}`).then(
        (bar) => {
          if (this.run !== run) return;
          this.observer = new MutationObserver(check);
          this.observer.observe(bar, {
            attributes: true,
            attributeFilter: ['like-status', 'aria-pressed'],
            subtree: true,
          });
          // The song that plays may be disliked already
          check();
        },
      );
    },
    stop() {
      this.run = undefined;
      this.observer?.disconnect();
      if (this.onSong) {
        document.removeEventListener('videodatachange', this.onSong);
      }
    },
  },
});

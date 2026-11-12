import { t } from '@/i18n';
import { type MenuTemplate } from '@/menu';
import { createPlugin } from '@/utils';
import { waitForElement } from '@/utils/wait-for-element';

import style from './style.css?inline';

export type HideCoverPluginConfig = {
  enabled: boolean;
  mode: 'black' | 'hidden';
};

// The phone layout replaces the player, so the observer watches the whole
// player page and reacts only to the parts that decide Song mode.
const songModeParts = 'ytmusic-player, #song-image, #song-video';

// The page sizes the player from the column only on window resize, so it has
// to measure again whenever the column changes size. Its own measuring method
// leaves the video player and the other resize listeners alone.
const relayout = () =>
  document
    .querySelector<HTMLElement & { updatePlayerWidth?: () => void }>(
      'ytmusic-player-page',
    )
    ?.updatePlayerWidth?.();

const updateSongMode = () => {
  const songImage = document.querySelector('#song-image');
  const isSongMode =
    !!songImage && getComputedStyle(songImage).display !== 'none';
  if (document.body.hasAttribute('hide-cover-song') === isSongMode) return;
  document.body.toggleAttribute('hide-cover-song', isSongMode);
  relayout();
};

export default createPlugin({
  name: () => t('plugins.hide-cover.name'),
  description: () => t('plugins.hide-cover.description'),
  restartNeeded: false,
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- the cast sets the config type that createPlugin infers
  config: { enabled: false, mode: 'black' } as HideCoverPluginConfig,
  stylesheets: [style],
  menu: async ({ getConfig, setConfig }): Promise<MenuTemplate> => {
    const config = await getConfig();

    return (['black', 'hidden'] as const).map((mode) => ({
      label: t(`plugins.hide-cover.menu.${mode}`),
      type: 'radio',
      checked: config.mode === mode,
      click() {
        setConfig({ mode });
      },
    }));
  },

  renderer: {
    observer: null as MutationObserver | null,

    async start({ getConfig }) {
      document.body.setAttribute('hide-cover', (await getConfig()).mode);

      const observer = new MutationObserver((mutations) => {
        if (
          mutations.some(
            ({ target }) =>
              target instanceof Element && target.matches(songModeParts),
          )
        )
          updateSongMode();
      });
      this.observer = observer;
      // Not awaited: the loader starts plugins one after another and calls
      // stop() only on plugins whose start() has finished.
      waitForElement('ytmusic-player-page').then((playerPage) => {
        // stop() may have run while the page was loading
        if (this.observer !== observer) return;
        observer.observe(playerPage, { attributes: true, subtree: true });
        updateSongMode();
      });
    },
    onConfigChange(newConfig) {
      document.body.setAttribute('hide-cover', newConfig.mode);
      relayout();
    },
    stop() {
      this.observer?.disconnect();
      this.observer = null;
      document.body.removeAttribute('hide-cover');
      document.body.removeAttribute('hide-cover-song');
      relayout();
    },
  },
});

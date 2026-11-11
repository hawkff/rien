import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';

import { t } from '@/i18n';
import { playerBar } from '@/providers/player-bar';
import { createRenderer } from '@/utils';

import { CaptionsSettingButton } from './templates/captions-settings-template';

import type { MusicPlayer } from '@/types/music-player';
import type { AppElement } from '@/types/queue';

export interface LanguageOptions {
  displayName: string;
  id: string | null;
  is_default: boolean;
  is_servable: boolean;
  is_translateable: boolean;
  kind: string;
  languageCode: string; // 2 length
  languageName: string;
  name: string | null;
  vss_id: string;
}

export interface CaptionsSelectorConfig {
  enabled: boolean;
  disableCaptions: boolean;
  autoload: boolean;
  lastCaptionsCode: string;
}

const [hidden, setHidden] = createSignal(false);

export default createRenderer<
  {
    captionsSettingsButton?: HTMLElement;
    captionTrackList: LanguageOptions[] | null;
    api: MusicPlayer | null;
    config: CaptionsSelectorConfig | null;
    videoChangeListener: () => void;
    newerBarClick?: (event: MouseEvent) => void;
  },
  CaptionsSelectorConfig
>({
  captionTrackList: null,
  api: null,
  config: null,
  videoChangeListener() {
    if (this.config?.disableCaptions) {
      setTimeout(() => this.api!.unloadModule('captions'), 100);
      setHidden(true);
      return;
    }

    this.api!.loadModule('captions');

    setTimeout(() => {
      this.captionTrackList =
        this.api!.getOption('captions', 'tracklist') ?? [];

      if (this.config!.autoload && this.config!.lastCaptionsCode) {
        this.api?.setOption('captions', 'track', {
          languageCode: this.config!.lastCaptionsCode,
        });
      }

      setHidden(!this.captionTrackList?.length);
    }, 250);
  },
  async start({ getConfig }) {
    this.config = await getConfig();
  },
  stop() {
    this.api?.unloadModule('captions');
    document
      .querySelector('video')
      ?.removeEventListener('peard:src-changed', this.videoChangeListener);
    if (this.captionsSettingsButton) {
      document
        .querySelector('.right-controls-buttons')
        ?.removeChild(this.captionsSettingsButton);
    }
    if (this.newerBarClick) {
      window.removeEventListener('click', this.newerBarClick, true);
    }
  },
  onPlayerApiReady(playerApi, { ipc, setConfig }) {
    this.api = playerApi;

    const chooseCaptions = async () => {
      const appApi = document.querySelector<AppElement>('ytmusic-app');

      if (this.captionTrackList?.length) {
        const currentCaptionTrack = playerApi.getOption<LanguageOptions>(
          'captions',
          'track',
        );

        let currentIndex = currentCaptionTrack
          ? this.captionTrackList.indexOf(
              this.captionTrackList.find(
                (track) =>
                  track.languageCode === currentCaptionTrack.languageCode,
              )!,
            )
          : null;

        const captionLabels = [
          ...this.captionTrackList.map((track) => track.displayName),
          t('plugins.captions-selector.prompt.selector.none'),
        ];

        currentIndex = (await ipc.invoke(
          'peard:captions-selector',
          captionLabels,
          currentIndex,
        )) as number;
        if (currentIndex === null) {
          return;
        }

        const newCaptions = this.captionTrackList[currentIndex];
        setConfig({ lastCaptionsCode: newCaptions?.languageCode });
        if (newCaptions) {
          playerApi.setOption('captions', 'track', {
            languageCode: newCaptions.languageCode,
          });
          appApi?.toastService?.show(
            t('plugins.captions-selector.toast.caption-changed', {
              language: newCaptions.displayName,
            }),
          );
        } else {
          playerApi.setOption('captions', 'track', {});
          appApi?.toastService?.show(
            t('plugins.captions-selector.toast.caption-disabled'),
          );
        }

        setTimeout(() => playerApi.playVideo());
      } else {
        appApi?.toastService?.show(
          t('plugins.captions-selector.toast.no-captions'),
        );
      }
    };

    const buttons = document.querySelector('.right-controls-buttons');
    if (buttons) {
      render(
        () => (
          <Show when={!hidden()}>
            <CaptionsSettingButton
              label={t('plugins.captions-selector.templates.title')}
              onClick={chooseCaptions}
              ref={this.captionsSettingsButton}
            />
          </Show>
        ),
        buttons,
      );
    } else {
      // The newer player bar has a captions button of its own, which turns the
      // default captions on and off. The list opens from it instead: a capture
      // on window runs before the site's own handlers. Without the song's
      // tracks, or with captions turned off in the plugin, the site's button
      // keeps its job.
      this.newerBarClick = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (!target.closest(playerBar.captions)) return;
        if (this.config?.disableCaptions || !this.captionTrackList?.length) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        chooseCaptions();
      };
      window.addEventListener('click', this.newerBarClick, true);
    }

    this.captionTrackList =
      this.api.getOption<LanguageOptions[]>('captions', 'tracklist') ?? [];

    document
      .querySelector('video')
      ?.addEventListener('peard:src-changed', this.videoChangeListener);
    // A song can already play when the plugin starts, as after a page load
    this.videoChangeListener();
  },
  onConfigChange(newConfig) {
    this.config = newConfig;
  },
});

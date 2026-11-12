import { toKeyEvent } from 'keyboardevent-from-electron-accelerator';

import { t } from '@/i18n';
import {
  appStore,
  isFullscreen,
  setFullscreen,
  setMuteAndVolume,
  skip,
  toggleMute,
} from '@/providers/player-bar';
import { createRenderer } from '@/utils';

import { type Command, commandFor, parseKeys, repeatable } from './keys';

import type { MpvKeysConfig } from './index';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

type Bindings = ReturnType<typeof parseKeys>['bindings'];

// The player plays rates in steps of 0.05 between the first and last of its
// listed rates; mpv's [ and ] multiply by 1.1.
const setSpeed = (api: MusicPlayer, rate: number) => {
  const rates = api.getAvailablePlaybackRates();
  const speed =
    Math.round(
      Math.min(Math.max(rate, Math.min(...rates)), Math.max(...rates)) * 20,
    ) / 20;
  // The store holds what the newer bar's speed button shows
  appStore()?.dispatch({ type: 'SET_PLAYBACK_RATE', payload: speed });
  // Playback Speed keeps its own speed on the video, so while it is on it
  // takes this one and cancels the event.
  const taken = !window.dispatchEvent(
    new CustomEvent('peard:set-playback-speed', {
      detail: speed,
      cancelable: true,
    }),
  );
  // The newer bar sets the player back when the store's rate changes in the
  // same task
  if (!taken) setTimeout(() => api.setPlaybackRate(speed));
};

const run = (api: MusicPlayer, command: Command) => {
  // Playback Speed sets the video's rate, which the player does not report
  const speed =
    document.querySelector('video')?.playbackRate ?? api.getPlaybackRate();
  switch (command.name) {
    case 'play-pause':
      // 1 is playing, 3 buffering
      if ([1, 3].includes(api.getPlayerState())) api.pauseVideo();
      else api.playVideo();
      break;
    case 'seek':
      api.seekBy(command.amount);
      break;
    case 'next':
    case 'previous':
      skip(command.name, api);
      break;
    case 'volume':
      setMuteAndVolume(
        api,
        api.isMuted(),
        Math.min(Math.max(api.getVolume() + command.amount, 0), 100),
      );
      break;
    case 'mute':
      toggleMute(api);
      break;
    case 'speed-down':
      setSpeed(api, speed / 1.1);
      break;
    case 'speed-up':
      setSpeed(api, speed * 1.1);
      break;
    case 'speed-half':
      setSpeed(api, speed / 2);
      break;
    case 'speed-double':
      setSpeed(api, speed * 2);
      break;
    case 'speed-reset':
      setSpeed(api, 1);
      break;
    case 'fullscreen':
      setFullscreen(!isFullscreen());
      break;
    case 'repeat-one': {
      const store = appStore();
      const mode = store?.getState().queue.repeatMode;
      store?.dispatch({
        type: 'SET_REPEAT',
        payload: mode === 'ONE' ? 'NONE' : 'ONE',
      });
      break;
    }
  }
};

// Keys that mpv-keys takes from other plugins, each as a notice
const clashes = async (taken: Bindings) => {
  const notices: string[] = [];
  const config = (id: string) =>
    window.ipcRenderer.invoke('peard:get-config', id) as Promise<
      Record<string, unknown>
    >;
  const pip = await config('picture-in-picture');
  if (pip.enabled && typeof pip.hotkey === 'string' && pip.hotkey) {
    try {
      const { key = '', code = '', ...modifiers } = toKeyEvent(pip.hotkey);
      // The hotkey matches a press by its key in either case or by its code,
      // with the modifiers as written
      const press = (name: string) => ({
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        ...modifiers,
        key: name,
        isComposing: false,
        composedPath: () => [],
      });
      if (
        [key, key.toUpperCase(), code].some((name) =>
          commandFor(press(name), taken),
        )
      ) {
        notices.push(
          t('plugins.mpv-keys.notice.picture-in-picture', {
            key: pip.hotkey,
            plugin: t('plugins.picture-in-picture.name'),
          }),
        );
      }
    } catch {
      // A hotkey that is no accelerator matches no key press
    }
  }
  const volume = await config('precise-volume');
  if (
    volume.enabled &&
    volume.arrowsShortcut &&
    // Precise Volume reads the arrow's code and ignores Shift
    ['UP', 'DOWN', 'Shift+UP', 'Shift+DOWN'].some((key) => taken.has(key))
  ) {
    notices.push(
      t('plugins.mpv-keys.notice.precise-volume', {
        plugin: t('plugins.precise-volume.name'),
      }),
    );
  }
  return notices;
};

let api: MusicPlayer | undefined;
let ipc: RendererContext<MpvKeysConfig>['ipc'] | undefined;
let bindings: Bindings = new Map();
let skipped: string[] = [];
let shown = new Set<string>();
let reporting = Promise.resolve();

// Shows each clash and each skipped entry once, and again only after the
// settings behind it change
const report = () => {
  reporting = reporting
    .then(async () => {
      if (!api) return;
      const notices = await clashes(bindings);
      if (skipped.length) {
        notices.unshift(
          t('plugins.mpv-keys.notice.skipped', { entries: skipped.join(', ') }),
        );
      }
      const next = new Set<string>();
      for (const notice of notices) {
        try {
          if (!shown.has(notice)) await ipc?.invoke('mpv-keys:notify', notice);
          next.add(notice);
        } catch (error) {
          // Not marked as shown, so the next report tries again
          console.error('mpv-keys:', error);
        }
      }
      shown = next;
    })
    // A failed report leaves the queue open for the next one
    .catch((error: unknown) => console.error('mpv-keys:', error));
};

const apply = (config: MpvKeysConfig) => {
  ({ bindings, skipped } = parseKeys(config.keys));
  report();
};

// A listener that went through the context bridge cannot be removed again,
// so this one stays for the page's life and does nothing while stopped.
let watchesOthers = false;
const watchOthers = () => {
  if (watchesOthers) return;
  watchesOthers = true;
  window.ipcRenderer.on('config-changed', (_, id: string) => {
    if (id === 'picture-in-picture' || id === 'precise-volume') report();
  });
};

const onKeyDown = (event: KeyboardEvent) => {
  const command = commandFor(event, bindings);
  if (!command || !api) return;
  // The site has shortcuts of its own for some of these keys
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.repeat && !repeatable.has(command.name)) return;
  run(api, command);
};

export const renderer = createRenderer<unknown, MpvKeysConfig>({
  async onPlayerApiReady(playerApi, context) {
    api = playerApi;
    ipc = context.ipc;
    apply(await context.getConfig());
    window.addEventListener('keydown', onKeyDown, true);
    watchOthers();
  },
  onConfigChange(config) {
    apply(config);
  },
  stop() {
    window.removeEventListener('keydown', onKeyDown, true);
    api = undefined;
    shown = new Set();
  },
});

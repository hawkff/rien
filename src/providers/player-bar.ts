import { LikeType } from '@/types/datahost-get-state';

import type { MusicPlayer } from '@/types/music-player';
import type { QueueElement } from '@/types/queue';

// The site serves one of two player bars: ytmusic-player-bar, or the newer
// ytmusic-miniplayer. The player page holds a second ytmusic-miniplayer as its
// top bar, first in the document; the bar at the bottom of the window is a
// child of ytmusic-app-layout.
export const newerBar = 'ytmusic-app-layout > ytmusic-miniplayer';

// The newer bar marks its controls with the site's visual element types
// (client-ve-type), which are the same in every language.
const newerBarButton = (veType: number) =>
  `${newerBar} [client-ve-type="${veType}"] button`;

export const playerBar = {
  previous: `.previous-button.ytmusic-player-bar, ${newerBarButton(36840)}`,
  next: `.next-button.ytmusic-player-bar, ${newerBarButton(36841)}`,
  captions: newerBarButton(16500),
  like: `${newerBar} like-button-view-model button`,
  dislike: `${newerBar} dislike-button-view-model button`,
};

// The bar's own Previous or Next when it shows one, the player otherwise: the
// newer bar leaves them out in a narrow window.
export const skip = (direction: 'previous' | 'next', api: MusicPlayer) => {
  const button = document.querySelector<HTMLElement>(playerBar[direction]);
  if (button) button.click();
  else if (direction === 'next') api.nextVideo();
  else api.previousVideo();
};

// The app's store, the same with either bar
export const appStore = () =>
  document.querySelector<QueueElement>('#queue')?.queue.store.store;

// What the site's player controller does for the bars: the player sounds, the
// store shows.
export const setMuteAndVolume = (
  api: MusicPlayer,
  muted: boolean,
  volume: number,
) => {
  if (api.isMuted() !== muted) {
    if (muted) api.mute();
    else api.unMute();
  }
  api.setVolume(volume);
  appStore()?.dispatch({ type: 'SET_MUTED', payload: muted });
  if (!muted) appStore()?.dispatch({ type: 'SET_VOLUME', payload: volume });
};

export const toggleMute = (api: MusicPlayer) => {
  // After a volume of 0 the store still has the volume before it
  const volume = api.getVolume() || (appStore()?.getState().player.volume ?? 0);
  setMuteAndVolume(api, !api.isMuted(), volume);
};

// Both bars' layouts mark fullscreen on ytmusic-app-layout
export const isFullscreen = () =>
  document
    .querySelector('ytmusic-app-layout')
    ?.hasAttribute('player-fullscreened') ?? false;

export const setFullscreen = (fullscreen: boolean) => {
  if (fullscreen === isFullscreen()) return;
  if (fullscreen) {
    document.querySelector<HTMLElement>('.fullscreen-button')?.click();
    return;
  }
  // The newer bar's layout has no exit button; the site follows the page
  // leaving fullscreen as well.
  const exit = document.querySelector<HTMLElement>('.exit-fullscreen-button');
  if (exit) exit.click();
  else if (document.fullscreenElement) document.exitFullscreen();
};

const mapLikeStatus = (status: string | null): LikeType =>
  Object.values(LikeType).includes(status as LikeType)
    ? (status as LikeType)
    : LikeType.Indifferent;

export const getLikeStatus = () => {
  const older = document.querySelector('#like-button-renderer');
  if (older) return mapLikeStatus(older.getAttribute('like-status'));
  if (document.querySelector(`${playerBar.like}[aria-pressed="true"]`)) {
    return LikeType.Like;
  }
  if (document.querySelector(`${playerBar.dislike}[aria-pressed="true"]`)) {
    return LikeType.Dislike;
  }
  return LikeType.Indifferent;
};

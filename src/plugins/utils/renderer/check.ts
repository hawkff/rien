import { newerBar } from '@/providers/player-bar';

export const isMusicOrVideoTrack = () => {
  for (const menuSelector of document.querySelectorAll<
    HTMLAnchorElement & {
      data: {
        watchEndpoint: {
          videoId: string;
        };
        addToPlaylistEndpoint: {
          videoId: string;
        };
        clickTrackingParams: string;
      };
    }
  >('tp-yt-paper-listbox #navigation-endpoint')) {
    if (
      menuSelector?.data?.addToPlaylistEndpoint?.videoId ||
      menuSelector?.data?.watchEndpoint?.videoId
    ) {
      return true;
    }
  }
  return false;
};

export const isAlbumOrPlaylist = () => {
  for (const menuSelector of document.querySelectorAll<
    HTMLAnchorElement & {
      data: {
        addToPlaylistEndpoint: {
          playlistId: string;
        };
        clickTrackingParams: string;
      };
    }
  >('tp-yt-paper-listbox #navigation-endpoint')) {
    if (menuSelector?.data?.addToPlaylistEndpoint?.playlistId) {
      return true;
    }
  }
  return false;
};

// The popup forwards its events to what opened it: the older bar's menu, or a
// part of the newer bar's menu button (visual element type 7591)
export const isPlayerMenu = (menu?: HTMLElement | null) => {
  const sink = (
    menu?.parentElement as
      | (HTMLElement & {
          ytEventForwardingBehavior: {
            forwarder_: {
              eventSink: HTMLElement;
            };
          };
        })
      | null
  )?.ytEventForwardingBehavior?.forwarder_?.eventSink;
  return Boolean(
    sink?.matches('ytmusic-menu-renderer.ytmusic-player-bar') ||
    sink?.closest(`${newerBar} [client-ve-type="7591"]`),
  );
};

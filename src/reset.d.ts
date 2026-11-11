import '@total-typescript/ts-reset';

import type * as config from './config';
import type { t } from '@/i18n';
import type { LikeType } from '@/types/datahost-get-state';
import type { VideoDataChanged } from '@/types/video-data-changed';
import type { ipcRenderer as electronIpcRenderer } from 'electron';
import type is from 'electron-is';
import type { trustedTypes } from 'trusted-types';
import type { languageResource } from 'virtual:i18n';

declare global {
  interface Compressor {
    audioSource: MediaElementAudioSourceNode;
    audioContext: AudioContext;
  }

  interface DocumentEventMap {
    'peard:audio-can-play': CustomEvent<Compressor>;
    'videodatachange': CustomEvent<VideoDataChanged>;
  }

  interface Window {
    trustedTypes?: typeof trustedTypes;
    ipcRenderer: typeof electronIpcRenderer;
    mainConfig: typeof config;
    electronIs: typeof is;
    getLanguageResource: typeof languageResource;
    injectRendererPlugin?: (id: string) => Promise<void>;
    ELECTRON_RENDERER_URL: string | undefined;
    /**
     * Internal variable (Last interaction time)
     */
    _lact: number;
    navigation: Navigation;
    download: () => void;
    togglePictureInPicture: () => void;
    reload: () => void;
    getLikeStatus: () => LikeType;
    i18n: {
      t: typeof t;
    };
  }
}

// import { Howl as _Howl } from 'howler';
declare module 'howler' {
  interface Howl {
    _sounds: {
      _paused: boolean;
      _ended: boolean;
      _id: string;
      _node: HTMLMediaElement;
    }[];
  }
}

import type { ProviderName } from './providers';
import type { SongInfo } from '@/providers/song-info';

export type SyncedLyricsPluginConfig = {
  enabled: boolean;
  preferredProvider?: ProviderName;
  preciseTiming: boolean;
  showTimeCodes: boolean;
  defaultTextString: string | string[];
  showLyricsEvenIfInexact: boolean;
  lineEffect: LineEffect;
  romanization: boolean;
  convertChineseCharacter?:
    | 'simplifiedToTraditional'
    | 'traditionalToSimplified'
    | 'disabled';
};

export type LineLyricsStatus = 'previous' | 'current' | 'upcoming';

export type LineLyrics = {
  time: string;
  timeInMs: number;
  duration: number;

  text: string;
  status: LineLyricsStatus;
};

export type LineEffect = 'fancy' | 'scale' | 'offset' | 'focus';

// The lyrics shown for the current song, as the API server gives them
export type CurrentLyrics = {
  provider: string;
  title: string;
  artists: string[];
  lines: { timeMs: number; durationMs: number | null; text: string }[] | null;
  plain: string | null;
};

export interface LyricResult {
  title: string;
  artists: string[];

  lyrics?: string;
  lines?: LineLyrics[];
}

// prettier-ignore
export type SearchSongInfo = Pick<SongInfo, 'title' | 'alternativeTitle' | 'artist' | 'album' | 'songDuration' | 'videoId' | 'tags'>;

export interface LyricProvider {
  name: string;
  baseUrl: string;

  search(songInfo: SearchSongInfo): Promise<LyricResult | null>;
}

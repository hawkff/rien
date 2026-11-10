import { createMemo, runWithOwner } from 'solid-js';
import { createStore } from 'solid-js/store';

import { getSongInfo } from '@/providers/song-info-front';

import { reactiveOwner } from './reactive-root';

import {
  type ProviderName,
  providerNames,
  type ProviderState,
} from '../providers';
import { providers } from '../providers/renderer';

import type { SongInfo } from '@/providers/song-info';

type LyricsStore = {
  provider: ProviderName;
  current: ProviderState;
  lyrics: Record<ProviderName, ProviderState>;
};

const initialData = () =>
  providerNames.reduce(
    (acc, name) => {
      acc[name] = { state: 'fetching', data: null, error: null };
      return acc;
    },
    {} as LyricsStore['lyrics'],
  );

export const [lyricsStore, setLyricsStore] = createStore<LyricsStore>({
  provider: providerNames[0],
  lyrics: initialData(),
  get current(): ProviderState {
    return this.lyrics[this.provider];
  },
});

export const currentLyrics = runWithOwner(reactiveOwner, () =>
  createMemo(() => {
    const provider = lyricsStore.provider;
    return lyricsStore.lyrics[provider];
  }),
)!;

type VideoId = string;

type SearchCache = Record<ProviderName, ProviderState>;

// Lyrics are kept for this many songs, so the cache stops growing while the
// app runs. A song that was dropped is searched for again.
const maxCachedSongs = 50;
const searchCache = new Map<VideoId, SearchCache>();

// The store gets copies, so it never shares a provider's state with the cache.
const forStore = (state: ProviderState): ProviderState => ({
  ...state,
  data: state.data ? { ...state.data } : null,
});

// Searches one provider. The result goes into the song's cache entry, and
// into the store while that song is the current one and the entry is still the
// song's: an entry that was dropped can have a newer one in its place.
const search = (
  providerName: ProviderName,
  info: SongInfo,
  cache: SearchCache,
) => {
  const update = (state: ProviderState) => {
    cache[providerName] = state;
    if (
      searchCache.get(info.videoId) === cache &&
      getSongInfo().videoId === info.videoId
    ) {
      setLyricsStore('lyrics', (old) => ({
        ...old,
        [providerName]: forStore(state),
      }));
    }
  };

  update({ state: 'fetching', data: null, error: null });
  providers[providerName]
    .search(info)
    .then((data) => update({ state: 'done', data, error: null }))
    .catch((error: Error) => {
      console.error(error);
      update({ state: 'error', data: null, error });
    });
};

export const fetchLyrics = (info: SongInfo) => {
  const cache = searchCache.get(info.videoId);
  if (cache) {
    // Searches still under way add their results when they arrive.
    if (getSongInfo().videoId === info.videoId) {
      setLyricsStore(
        'lyrics',
        () =>
          Object.fromEntries(
            providerNames.map((name) => [name, forStore(cache[name])]),
          ) as SearchCache,
      );
    }

    return;
  }

  const newCache = initialData();
  searchCache.set(info.videoId, newCache);
  if (searchCache.size > maxCachedSongs) {
    searchCache.delete(searchCache.keys().next().value!);
  }

  for (const providerName of providerNames) {
    search(providerName, info, newCache);
  }
};

export const retrySearch = (provider: ProviderName, info: SongInfo) => {
  const cache = searchCache.get(info.videoId);
  if (cache) search(provider, info, cache);
  else fetchLyrics(info);
};

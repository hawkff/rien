// Turns the site's answers (renderer JSON) into plain items for the API's
// browse routes, so clients don't need to know the site's page layout.

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const object = (value: Json | undefined) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
const array = (value: Json | undefined) => (Array.isArray(value) ? value : []);
const string = (value: Json | undefined) =>
  typeof value === 'string' ? value : undefined;
const at = (value: Json | undefined, ...path: (string | number)[]) =>
  path.reduce<Json | undefined>(
    (current, key) =>
      typeof key === 'number' ? array(current)[key] : object(current)?.[key],
    value,
  );

// The first value under `key`, searched depth first
const find = (value: Json | undefined, key: string): Json | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = find(item, key);
      if (found !== undefined) return found;
    }
  } else if (object(value)) {
    const entries = object(value)!;
    if (key in entries) return entries[key];
    for (const item of Object.values(entries)) {
      const found = find(item, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

export type Ref = { id: string | null; name: string };
export type ItemType =
  | 'song'
  | 'video'
  | 'episode'
  | 'album'
  | 'artist'
  | 'playlist'
  | 'podcast'
  | 'profile';
export type Item = {
  type: ItemType;
  // A video ID for songs, videos and episodes, a browse ID for the rest
  id: string;
  title: string;
  // The line under the title, as the site shows it
  subtitle: string;
  artists: Ref[];
  album: Ref | null;
  // Seconds
  duration: number | null;
  thumbnail: string | null;
  // The list that plays it: an album's or a playlist's, or the one a song sits in
  playlistId: string | null;
  // The song's place in a playlist, which edits to the playlist name
  slot: string | null;
  available: boolean;
  // In the library, and the site's tokens that save it there or remove it
  library: Library | null;
  like: LikeStatus | null;
};
export type Library = {
  saved: boolean;
  add: string | null;
  remove: string | null;
};
export type LikeStatus = 'LIKE' | 'DISLIKE' | 'INDIFFERENT';
const likeStatuses = new Set<string>(['LIKE', 'DISLIKE', 'INDIFFERENT']);

// The library and like state that a row's menu holds for a signed-in account
const menuState = (menu: Json | undefined) => {
  const toggle = array(at(menu, 'menuRenderer', 'items'))
    .map((entry) => object(at(entry, 'toggleMenuServiceItemRenderer')))
    .find((entry) =>
      /^(BOOKMARK|LIBRARY_)/.test(
        string(at(entry, 'defaultIcon', 'iconType')) ?? '',
      ),
    );
  const token = (endpoint: string) =>
    string(at(toggle, endpoint, 'feedbackEndpoint', 'feedbackToken')) ?? null;
  // The newer menu says whether it is saved and always offers saving first;
  // the older one starts with the action that undoes the current state
  const older = toggle?.isToggled === undefined;
  const saved = older
    ? ['LIBRARY_SAVED', 'LIBRARY_REMOVE'].includes(
        string(at(toggle, 'defaultIcon', 'iconType')) ?? '',
      )
    : toggle?.isToggled === true;
  const [add, remove] =
    older && saved
      ? [token('toggledServiceEndpoint'), token('defaultServiceEndpoint')]
      : [token('defaultServiceEndpoint'), token('toggledServiceEndpoint')];
  const like = string(at(find(menu, 'likeButtonRenderer'), 'likeStatus'));
  return {
    library: toggle ? { saved, add, remove } : null,
    like: like && likeStatuses.has(like) ? (like as LikeStatus) : null,
  };
};

const pageTypes: Record<string, ItemType> = {
  MUSIC_PAGE_TYPE_ALBUM: 'album',
  MUSIC_PAGE_TYPE_AUDIOBOOK: 'album',
  MUSIC_PAGE_TYPE_ARTIST: 'artist',
  MUSIC_PAGE_TYPE_LIBRARY_ARTIST: 'artist',
  MUSIC_PAGE_TYPE_PLAYLIST: 'playlist',
  MUSIC_PAGE_TYPE_USER_CHANNEL: 'profile',
  MUSIC_PAGE_TYPE_PODCAST_SHOW_DETAIL_PAGE: 'podcast',
  MUSIC_PAGE_TYPE_NON_MUSIC_AUDIO_TRACK_PAGE: 'episode',
};

type Run = { text: string; endpoint?: JsonObject };
const runs = (text: Json | undefined): Run[] =>
  array(at(text, 'runs')).map((run) => ({
    text: string(at(run, 'text')) ?? '',
    endpoint: object(at(run, 'navigationEndpoint')),
  }));
const joined = (text: Json | undefined) =>
  runs(text)
    .map((run) => run.text)
    .join('');

const browseOf = (endpoint: Json | undefined) => {
  const browse = object(at(endpoint, 'browseEndpoint'));
  const id = string(at(browse, 'browseId'));
  if (!id) return undefined;
  const pageType = string(
    at(
      browse,
      'browseEndpointContextSupportedConfigs',
      'browseEndpointContextMusicConfig',
      'pageType',
    ),
  );
  return { id, type: pageType ? pageTypes[pageType] : undefined };
};
const watchOf = (endpoint: Json | undefined) => {
  const watch = object(at(endpoint, 'watchEndpoint'));
  const videoId = string(at(watch, 'videoId'));
  if (!videoId) return undefined;
  const videoType = string(
    at(
      watch,
      'watchEndpointMusicSupportedConfigs',
      'watchEndpointMusicConfig',
      'musicVideoType',
    ),
  );
  const type: ItemType =
    !videoType || videoType === 'MUSIC_VIDEO_TYPE_ATV'
      ? 'song'
      : videoType === 'MUSIC_VIDEO_TYPE_PODCAST_EPISODE'
        ? 'episode'
        : 'video';
  return { videoId, type, playlistId: string(at(watch, 'playlistId')) };
};
const playlistOf = (endpoint: Json | undefined) =>
  string(at(endpoint, 'watchPlaylistEndpoint', 'playlistId')) ??
  string(at(endpoint, 'watchEndpoint', 'playlistId'));

const thumbnailOf = (value: Json | undefined) => {
  const thumbnails = array(find(value, 'thumbnails'));
  return string(at(thumbnails[thumbnails.length - 1], 'url')) ?? null;
};

const durationPattern = /^(\d+:)?\d{1,2}:\d{2}$/;
export const seconds = (text: string) =>
  durationPattern.test(text.trim())
    ? text
        .trim()
        .split(':')
        .reduce((total, part) => total * 60 + Number(part), 0)
    : null;

const yearPattern = /^\d{4}$/;

// Artists, album and length from the runs under a title. Artists are the runs
// that link to an artist or a channel; the subtitle keeps the rest.
const details = (all: Run[]) => {
  const artists: Ref[] = [];
  let album: Ref | null = null;
  let duration: number | null = null;
  for (const run of all) {
    const linked = browseOf(run.endpoint);
    if (linked?.type === 'artist' || linked?.type === 'profile') {
      artists.push({ id: linked.id, name: run.text });
    } else if (linked?.type === 'album') {
      album = { id: linked.id, name: run.text };
    } else if (!linked) {
      duration ??= seconds(run.text);
    }
  }
  return { artists, album, duration };
};

// A row of a list: songs in a search, an album or a playlist, and albums,
// artists and playlists in a search
export const parseListItem = (renderer: Json | undefined): Item | null => {
  const item = object(renderer);
  if (!item) return null;
  const columns = array(item.flexColumns).map((column) =>
    runs(at(column, 'musicResponsiveListItemFlexColumnRenderer', 'text')),
  );
  const title = columns[0]?.map((run) => run.text).join('') ?? '';
  const below = columns.slice(1).flatMap((column, index) =>
    // Columns after the first are parts of one line
    index ? [{ text: ' • ' }, ...column] : column,
  );
  const play = find(item.overlay, 'playNavigationEndpoint');
  const browse =
    browseOf(item.navigationEndpoint) ?? browseOf(columns[0]?.[0]?.endpoint);
  const watch =
    watchOf(columns[0]?.[0]?.endpoint) ??
    watchOf(play) ??
    (string(at(item, 'playlistItemData', 'videoId'))
      ? {
          videoId: string(at(item, 'playlistItemData', 'videoId'))!,
          type: 'song' as const,
          playlistId: undefined,
        }
      : undefined);

  // An episode's title links to its page, but it plays as a video
  const type: ItemType | undefined =
    browse?.type === 'episode' && watch
      ? 'episode'
      : browse && browse.type !== 'episode'
        ? browse.type
        : watch?.type;
  const id =
    type && ['song', 'video', 'episode'].includes(type)
      ? watch?.videoId
      : browse?.id;
  if (!type || !id) return null;

  const { artists, album, duration } = details(below);
  const fixed = array(item.fixedColumns).map((column) =>
    joined(at(column, 'musicResponsiveListItemFixedColumnRenderer', 'text')),
  );
  return {
    type,
    id,
    title,
    subtitle: below.map((run) => run.text).join(''),
    artists,
    album,
    duration:
      duration ?? fixed.map(seconds).find((value) => value !== null) ?? null,
    thumbnail: thumbnailOf(item.thumbnail),
    playlistId: playlistOf(play) ?? watch?.playlistId ?? null,
    slot: string(at(item, 'playlistItemData', 'playlistSetVideoId')) ?? null,
    available:
      item.musicItemRendererDisplayPolicy !==
      'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT',
    ...menuState(item.menu),
  };
};

// A card in a carousel: albums, singles, playlists and videos on artist pages
export const parseCard = (renderer: Json | undefined): Item | null => {
  const card = object(renderer);
  if (!card) return null;
  const title = runs(card.title);
  const below = runs(card.subtitle);
  const browse =
    browseOf(card.navigationEndpoint) ?? browseOf(title[0]?.endpoint);
  const watch = watchOf(card.navigationEndpoint) ?? watchOf(title[0]?.endpoint);
  const type = browse?.type ?? watch?.type;
  const id = browse?.id ?? watch?.videoId;
  if (!type || !id) return null;
  return {
    type,
    id,
    title: title.map((run) => run.text).join(''),
    subtitle: below.map((run) => run.text).join(''),
    ...details(below),
    thumbnail: thumbnailOf(card.thumbnailRenderer),
    playlistId:
      playlistOf(find(card.thumbnailOverlay, 'playNavigationEndpoint')) ??
      watch?.playlistId ??
      null,
    slot: null,
    available: true,
    ...menuState(card.menu),
  };
};

// The top result of a search
const parseTopResult = (renderer: Json | undefined): Item | null => {
  const card = object(renderer);
  if (!card) return null;
  const title = runs(card.title);
  const below = runs(card.subtitle);
  const browse = browseOf(card.onTap) ?? browseOf(title[0]?.endpoint);
  const watch = watchOf(card.onTap) ?? watchOf(title[0]?.endpoint);
  const type = browse?.type ?? watch?.type;
  const id = browse?.id ?? watch?.videoId;
  if (!type || !id) return null;
  return {
    type,
    id,
    title: title.map((run) => run.text).join(''),
    subtitle: below.map((run) => run.text).join(''),
    ...details(below),
    thumbnail: thumbnailOf(card.thumbnail),
    playlistId:
      playlistOf(find(card.thumbnailOverlay, 'playNavigationEndpoint')) ??
      watch?.playlistId ??
      null,
    slot: null,
    available: true,
    ...menuState(card.menu),
  };
};

const items = (list: Json | undefined) =>
  array(list)
    .map(
      (entry) =>
        parseListItem(at(entry, 'musicResponsiveListItemRenderer')) ??
        parseCard(at(entry, 'musicTwoRowItemRenderer')),
    )
    .filter((item) => item !== null);

const nextToken = (list: Json | undefined, shelf?: Json) =>
  string(
    find(
      array(list).find((entry) => object(entry)?.continuationItemRenderer),
      'token',
    ),
  ) ??
  string(
    at(shelf, 'continuations', 0, 'nextContinuationData', 'continuation'),
  ) ??
  null;

export type Page = { items: Item[]; continuation: string | null };

// A search, or the next page of one
export const parseSearch = (response: Json): Page => {
  const next = at(response, 'continuationContents', 'musicShelfContinuation');
  if (next) {
    return {
      items: items(at(next, 'contents')),
      continuation: nextToken(undefined, next),
    };
  }
  const found: Item[] = [];
  let continuation: string | null = null;
  const sections = array(at(find(response, 'sectionListRenderer'), 'contents'));
  for (const section of sections) {
    const top = at(section, 'musicCardShelfRenderer');
    if (top) {
      const item = parseTopResult(top);
      if (item) found.push(item);
      found.push(...items(at(top, 'contents')));
    }
    found.push(...items(at(section, 'itemSectionRenderer', 'contents')));
    const shelf = at(section, 'musicShelfRenderer');
    if (shelf) {
      found.push(...items(at(shelf, 'contents')));
      continuation ??= nextToken(at(shelf, 'contents'), shelf);
    }
  }
  return { items: found, continuation };
};

// A page of the library (songs, albums, artists, subscriptions, playlists,
// history), or its next page. The site lists them in shelves or in grids.
export const parseLibrary = (response: Json): Page => {
  const next =
    at(response, 'continuationContents', 'musicShelfContinuation') ??
    at(response, 'continuationContents', 'gridContinuation');
  if (next) {
    const list = at(next, 'contents') ?? at(next, 'items');
    return { items: items(list), continuation: nextToken(list, next) };
  }
  // The newer shape of a next page, as playlists already get it
  const appended = find(response, 'appendContinuationItemsAction');
  if (appended) {
    const list = at(appended, 'continuationItems');
    return { items: items(list), continuation: nextToken(list) };
  }
  const found: Item[] = [];
  let continuation: string | null = null;
  const sections = array(at(find(response, 'sectionListRenderer'), 'contents'));
  for (const section of sections) {
    const shelf =
      at(section, 'musicShelfRenderer') ?? at(section, 'gridRenderer');
    if (!shelf) continue;
    const list = at(shelf, 'contents') ?? at(shelf, 'items');
    found.push(...items(list));
    continuation ??= nextToken(list, shelf);
  }
  return { items: found, continuation };
};

const headerOf = (response: Json) =>
  object(find(response, 'musicResponsiveHeaderRenderer')) ??
  object(find(response, 'musicDetailHeaderRenderer'));

export type Album = {
  id: string;
  title: string;
  subtitle: string;
  artists: Ref[];
  year: string | null;
  // Song count and length, as the site shows them
  stats: string;
  thumbnail: string | null;
  playlistId: string | null;
};

export const parseAlbum = (id: string, response: Json) => {
  const header = headerOf(response);
  const subtitle = runs(header?.subtitle);
  const artists = details(runs(header?.straplineTextOne)).artists;
  const shelf = find(response, 'musicShelfRenderer');
  const album: Album = {
    id,
    title: joined(header?.title),
    subtitle: subtitle.map((run) => run.text).join(''),
    artists,
    year:
      subtitle.map((run) => run.text).find((text) => yearPattern.test(text)) ??
      null,
    stats: joined(header?.secondSubtitle),
    thumbnail: thumbnailOf(header?.thumbnail),
    playlistId:
      string(
        at(find(header?.buttons, 'watchPlaylistEndpoint'), 'playlistId'),
      ) ??
      string(at(find(header?.buttons, 'watchEndpoint'), 'playlistId')) ??
      null,
  };
  const tracks = items(at(shelf, 'contents')).map((track) => ({
    ...track,
    // The site can list an album's songs as their music videos
    type: track.type === 'video' ? ('song' as const) : track.type,
    // Rows of an album name their artists only where they differ
    artists: track.artists.length ? track.artists : artists,
    album: track.album ?? { id, name: album.title },
    thumbnail: track.thumbnail ?? album.thumbnail,
    playlistId: track.playlistId ?? album.playlistId,
  }));
  return { album, tracks };
};

export type Playlist = {
  id: string;
  title: string;
  subtitle: string;
  author: Ref | null;
  stats: string;
  thumbnail: string | null;
};

// A playlist's first page, or its next page of songs
export const parsePlaylist = (id: string, response: Json) => {
  const appended = find(response, 'appendContinuationItemsAction');
  const continued = at(
    response,
    'continuationContents',
    'musicPlaylistShelfContinuation',
  );
  if (appended || continued) {
    const list = appended
      ? at(appended, 'continuationItems')
      : at(continued, 'contents');
    return {
      playlist: null,
      tracks: items(list),
      continuation: nextToken(list, continued),
    };
  }
  const header = headerOf(response);
  const shelf = find(response, 'musicPlaylistShelfRenderer');
  const author = details(runs(header?.straplineTextOne)).artists[0] ?? null;
  const playlist: Playlist = {
    id,
    title: joined(header?.title),
    subtitle: joined(header?.subtitle),
    author,
    stats: joined(header?.secondSubtitle),
    thumbnail: thumbnailOf(header?.thumbnail),
  };
  const list = at(shelf, 'contents');
  return {
    playlist,
    tracks: items(list),
    continuation: nextToken(list, shelf),
  };
};

export type Artist = {
  id: string;
  name: string;
  // The audience figure under the name, as the site shows it
  stats: string;
  thumbnail: string | null;
};
export type Section = {
  title: string;
  items: Item[];
  // The page with all of them, such as the playlist of an artist's songs
  more: string | null;
};

export const parseArtist = (id: string, response: Json) => {
  const header =
    object(find(response, 'musicImmersiveHeaderRenderer')) ??
    object(find(response, 'musicVisualHeaderRenderer'));
  const artist: Artist = {
    id,
    name: joined(header?.title),
    stats:
      joined(header?.monthlyListenerCount) ||
      joined(find(header?.subscriptionButton, 'subscriberCountText')),
    thumbnail: thumbnailOf(header?.thumbnail),
  };
  const sections: Section[] = [];
  for (const section of array(
    at(find(response, 'sectionListRenderer'), 'contents'),
  )) {
    const shelf =
      object(at(section, 'musicShelfRenderer')) ??
      object(at(section, 'musicCarouselShelfRenderer'));
    if (!shelf) continue;
    const title =
      shelf.title ??
      at(shelf, 'header', 'musicCarouselShelfBasicHeaderRenderer', 'title');
    const list = items(shelf.contents);
    if (!list.length) continue;
    sections.push({
      title: joined(title),
      items: list,
      more:
        browseOf(runs(title)[0]?.endpoint)?.id ??
        browseOf(shelf.bottomEndpoint)?.id ??
        null,
    });
  }
  return { artist, sections };
};

// A song of the player's queue, and whether it plays
const queueItem = (entry: Json) => {
  const item =
    object(at(entry, 'playlistPanelVideoRenderer')) ??
    object(
      at(
        entry,
        'playlistPanelVideoWrapperRenderer',
        'primaryRenderer',
        'playlistPanelVideoRenderer',
      ),
    );
  const watch = watchOf(item?.navigationEndpoint);
  const videoId = string(item?.videoId) ?? watch?.videoId;
  if (!item || !videoId) return null;
  const below = runs(item.longBylineText);
  return {
    selected: item.selected === true,
    item: {
      type: watch?.type ?? 'song',
      id: videoId,
      title: joined(item.title),
      subtitle: below.map((run) => run.text).join(''),
      ...details(below),
      duration: seconds(joined(item.lengthText)),
      thumbnail: thumbnailOf(item.thumbnail),
      playlistId: watch?.playlistId ?? null,
      slot: string(item.playlistSetVideoId) ?? null,
      available: true,
      ...menuState(item.menu),
    } satisfies Item,
  };
};

// The player's queue with the index of the song that plays, and the songs
// the site plays after it while autoplay is on
export const parseQueue = (response: Json) => {
  const items: Item[] = [];
  let current: number | null = null;
  for (const entry of array(at(response, 'items'))) {
    const found = queueItem(entry);
    if (!found) continue;
    if (found.selected) current = items.length;
    items.push(found.item);
  }
  const encore = array(at(response, 'automixItems'))
    .map(queueItem)
    .filter((found) => found !== null)
    .map((found) => found.item);
  return { items, current, encore };
};

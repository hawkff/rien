import { createRoute } from '@hono/zod-openapi';

import { isEnabled } from '@/config/plugins';
import { getSongControls } from '@/providers/song-controls';

import { API_VERSION } from '../api-version';
import {
  type Json,
  parseAlbum,
  parseArtist,
  parseLibrary,
  parsePlaylist,
  parseSearch,
} from '../browse';
import {
  AlbumPageSchema,
  ArtistPageSchema,
  BrowseIdSchema,
  ContinuationQuerySchema,
  DownloadSchema,
  ErrorSchema,
  LibraryKindSchema,
  LyricsSchema,
  PlaylistPageSchema,
  PlayNowSchema,
  SearchPageSchema,
  SearchQuerySchema,
} from '../scheme';

import type { APIServerConfig } from '../../config';
import type { HonoApp } from '../types';
import type { CurrentLyrics } from '@/plugins/synced-lyrics/types';
import type { SongInfo } from '@/providers/song-info';
import type { BackendContext } from '@/types/contexts';

const json = <T>(schema: T, description = 'Success') => ({
  description,
  content: { 'application/json': { schema } },
});
const unavailable = json(ErrorSchema, 'The page could not answer');

const routes = {
  search: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/browse/search`,
    summary: 'search, with plain results',
    description:
      'Searches like the search box, with an optional filter, and gives plain items. Pass `continuation` from a result for its next page.',
    request: { query: SearchQuerySchema },
    responses: { 200: json(SearchPageSchema), 503: unavailable },
  }),
  album: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/browse/album/{id}`,
    summary: 'get an album',
    description: "An album's details and songs, by its browse ID (MPRE…)",
    request: { params: BrowseIdSchema },
    responses: { 200: json(AlbumPageSchema), 503: unavailable },
  }),
  artist: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/browse/artist/{id}`,
    summary: 'get an artist',
    description:
      "An artist's page by channel ID: top songs, albums, singles and more",
    request: { params: BrowseIdSchema },
    responses: { 200: json(ArtistPageSchema), 503: unavailable },
  }),
  playlist: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/browse/playlist/{id}`,
    summary: 'get a playlist',
    description:
      'A playlist and its songs, by playlist ID or browse ID (VL…). Pass `continuation` from a result for its next page.',
    request: { params: BrowseIdSchema, query: ContinuationQuerySchema },
    responses: { 200: json(PlaylistPageSchema), 503: unavailable },
  }),
  library: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/library/{kind}`,
    summary: 'get the library',
    description:
      "The signed-in account's library: songs, albums, artists, subscriptions, playlists, liked songs or history. Items carry the library and like state; liked songs carry their slot. Pass `continuation` from a result for its next page.",
    request: { params: LibraryKindSchema, query: ContinuationQuerySchema },
    responses: {
      200: json(SearchPageSchema),
      409: json(ErrorSchema, 'Rien is not signed in'),
      503: unavailable,
    },
  }),
  playNow: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/play-now`,
    summary: 'play a song or a list now',
    description:
      'Plays a song, a list (an album, a playlist) from its start, or a list from one of its songs. The queue becomes that list.',
    request: {
      body: {
        description: 'the song, the list, or both',
        content: { 'application/json': { schema: PlayNowSchema } },
        required: true,
      },
    },
    responses: { 204: { description: 'Success' } },
  }),
  lyrics: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/lyrics`,
    summary: 'get the current lyrics',
    description:
      'The lyrics Synced Lyrics shows for the current song, from the provider picked there',
    responses: {
      200: json(LyricsSchema),
      204: { description: 'No lyrics for this song (yet)' },
      409: json(ErrorSchema, 'Synced Lyrics is off'),
    },
  }),
  download: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/download`,
    summary: 'download a song',
    description:
      "Downloads a song, the current one by default, with the Downloader's settings",
    request: {
      body: { content: { 'application/json': { schema: DownloadSchema } } },
    },
    responses: {
      202: { description: 'The download started' },
      409: json(ErrorSchema, 'The Downloader is off, or nothing plays'),
    },
  }),
};

// Search filters, as the site's own filter chips send them
const filters = {
  all: undefined,
  songs: 'EgWKAQIIAWoQEAkQBRADEAQQChAQEBUQEQ%3D%3D',
  videos: 'EgWKAQIQAWoQEAkQBRADEAQQChAQEBUQEQ%3D%3D',
  albums: 'EgWKAQIYAWoQEAkQBRADEAQQChAQEBUQEQ%3D%3D',
  artists: 'EgWKAQIgAWoQEAkQBRADEAQQChAQEBUQEQ%3D%3D',
  playlists: 'EgeKAQQoAEABahAQCRAFEAMQBBAKEBAQFRAR',
};

export const register = (
  app: HonoApp,
  { window }: BackendContext<APIServerConfig>,
  songInfoGetter: () => SongInfo | undefined,
) => {
  // Asks the site's API through the page, with the page's session. The inputs
  // are validated and go in as JSON literals.
  const ask = async (endpoint: '/search' | '/browse', body: object) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer: unknown = await Promise.race([
        window.webContents.executeJavaScript(
          `document.querySelector('ytmusic-app')?.networkManager?.fetch(${JSON.stringify(endpoint)}, ${JSON.stringify(body)}) ?? null`,
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 20_000);
        }),
      ]);
      return (answer ?? null) as Json | null;
    } catch (error) {
      console.error('The page could not answer', endpoint, error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const noAnswer = { error: 'The page could not answer; try again' };

  app.openapi(routes.search, async (ctx) => {
    const { q, filter, continuation } = ctx.req.valid('query');
    const answer = await ask('/search', {
      query: q,
      params: filters[filter],
      continuation,
    });
    if (!answer) return ctx.json(noAnswer, 503);
    return ctx.json(parseSearch(answer), 200);
  });

  app.openapi(routes.album, async (ctx) => {
    const { id } = ctx.req.valid('param');
    const answer = await ask('/browse', { browseId: id });
    if (!answer) return ctx.json(noAnswer, 503);
    return ctx.json(parseAlbum(id, answer), 200);
  });

  app.openapi(routes.artist, async (ctx) => {
    const { id } = ctx.req.valid('param');
    const answer = await ask('/browse', { browseId: id });
    if (!answer) return ctx.json(noAnswer, 503);
    return ctx.json(parseArtist(id, answer), 200);
  });

  app.openapi(routes.playlist, async (ctx) => {
    const { id } = ctx.req.valid('param');
    const { continuation } = ctx.req.valid('query');
    const browseId = id.startsWith('VL') ? id : `VL${id}`;
    const answer = await ask(
      '/browse',
      continuation ? { continuation } : { browseId },
    );
    if (!answer) return ctx.json(noAnswer, 503);
    return ctx.json(parsePlaylist(browseId, answer), 200);
  });

  // The site's pages of the library; liked songs are the playlist LM
  const libraryPages = {
    songs: 'FEmusic_liked_videos',
    albums: 'FEmusic_liked_albums',
    artists: 'FEmusic_library_corpus_track_artists',
    subscriptions: 'FEmusic_library_corpus_artists',
    playlists: 'FEmusic_liked_playlists',
    likes: 'VLLM',
    history: 'FEmusic_history',
  };
  app.openapi(routes.library, async (ctx) => {
    const { kind } = ctx.req.valid('param');
    const { continuation } = ctx.req.valid('query');
    // Unknown when the page doesn't answer in time; the request then goes on
    let timer: NodeJS.Timeout | undefined;
    const signedIn = (await Promise.race([
      window.webContents
        .executeJavaScript('window.ytcfg?.get?.("LOGGED_IN") ?? null')
        .catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 5_000);
      }),
    ]).finally(() => clearTimeout(timer))) as boolean | null;
    if (signedIn === false) {
      return ctx.json({ error: 'Rien is not signed in' }, 409);
    }
    const browseId = libraryPages[kind];
    const answer = await ask(
      '/browse',
      continuation ? { continuation } : { browseId },
    );
    if (!answer) return ctx.json(noAnswer, 503);
    if (kind === 'likes') {
      const { tracks, continuation: next } = parsePlaylist(browseId, answer);
      return ctx.json({ items: tracks, continuation: next }, 200);
    }
    return ctx.json(parseLibrary(answer), 200);
  });

  app.openapi(routes.playNow, (ctx) => {
    getSongControls(window).playTarget(ctx.req.valid('json'));
    ctx.status(204);
    return ctx.body(null);
  });

  app.openapi(routes.lyrics, async (ctx) => {
    if (!(await isEnabled('synced-lyrics'))) {
      return ctx.json({ error: 'Synced Lyrics is off' }, 409);
    }
    const lyrics = (await window.webContents
      .executeJavaScript('window.getSyncedLyrics?.() ?? null')
      .catch(() => null)) as CurrentLyrics | null;
    if (!lyrics) return ctx.body(null, 204);
    return ctx.json(lyrics, 200);
  });

  app.openapi(routes.download, async (ctx) => {
    if (!(await isEnabled('downloader'))) {
      return ctx.json({ error: 'The Downloader is off' }, 409);
    }
    const videoId = ctx.req.valid('json').videoId ?? songInfoGetter()?.videoId;
    if (!videoId) return ctx.json({ error: 'Nothing plays' }, 409);
    const url = `https://music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com/watch?v=${videoId}`;
    // The Downloader's handler runs the download and reports in the app; the
    // request doesn't wait for it.
    window.webContents
      .executeJavaScript(
        `window.ipcRenderer.invoke('download-song', ${JSON.stringify(url)})`,
      )
      .catch((error: unknown) => console.error('Download failed', error));
    return ctx.body(null, 202);
  });
};

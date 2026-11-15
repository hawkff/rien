import { createRoute, z } from '@hono/zod-openapi';
import { ipcMain } from 'electron';

import { getSongControls } from '@/providers/song-controls';
import {
  LikeType,
  type RepeatMode,
  type VolumeState,
} from '@/types/datahost-get-state';

import { API_VERSION } from '../api-version';
import { type Json, parseQueue } from '../browse';
import { within } from '../page';
import {
  AddSongToQueueSchema,
  GoBackSchema,
  GoForwardScheme,
  MoveSongInQueueSchema,
  QueueItemsSchema,
  QueueParamsSchema,
  SearchSchema,
  SeekSchema,
  SetFullscreenSchema,
  SetQueueIndexSchema,
  SetVolumeSchema,
  SongInfoSchema,
  SwitchRepeatSchema,
  type ResponseSongInfo,
} from '../scheme';
import { ErrorSchema } from '../scheme/browse';

import type { APIServerConfig } from '../../config';
import type { HonoApp } from '../types';
import type { SongInfo } from '@/providers/song-info';
import type { BackendContext } from '@/types/contexts';
import type { QueueResponse } from '@/types/music-player-desktop-internal';
import type { Context } from 'hono';

// What a route that asks the page answers when the page doesn't, as while it
// loads
const pageSilent = {
  503: {
    description: 'The page did not answer in time',
    content: { 'application/json': { schema: ErrorSchema } },
  },
};
const noAnswer = { error: 'The page did not answer in time; try again' };

// The page's answer to a question over IPC, or undefined when none comes in
// time. The answer comes wrapped: the page may answer undefined itself.
const fromPage = <T>(channel: string, ask: () => void, ms = 10_000) =>
  new Promise<{ answer: T } | undefined>((resolve) => {
    const listener = (_: unknown, answer: T) => {
      clearTimeout(timer);
      resolve({ answer });
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener(channel, listener);
      resolve(undefined);
    }, ms);
    ipcMain.once(channel, listener);
    ask();
  });

const routes = {
  previous: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/previous`,
    summary: 'play previous song',
    description: 'Plays the previous song in the queue',
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  next: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/next`,
    summary: 'play next song',
    description: 'Plays the next song in the queue',
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  play: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/play`,
    summary: 'Play',
    description: 'Change the state of the player to play',
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  pause: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/pause`,
    summary: 'Pause',
    description: 'Change the state of the player to pause',
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  togglePlay: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/toggle-play`,
    summary: 'Toggle play/pause',
    description:
      'Change the state of the player to play if paused, or pause if playing',
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  getLikeState: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/like-state`,
    summary: 'get like state',
    description: 'Get the current like state',
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: z.object({
              state: z.enum(LikeType).nullable(),
            }),
          },
        },
      },
    },
  }),
  like: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/like`,
    summary: 'like song',
    description: 'Set the current song as liked',
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  dislike: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/dislike`,
    summary: 'dislike song',
    description: 'Set the current song as disliked',
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  seekTo: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/seek-to`,
    summary: 'seek',
    description: 'Seek to a specific time in the current song',
    request: {
      body: {
        description: 'seconds to seek to',
        content: {
          'application/json': {
            schema: SeekSchema,
          },
        },
      },
    },
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  goBack: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/go-back`,
    summary: 'go back',
    description: 'Move the current song back by a number of seconds',
    request: {
      body: {
        description: 'seconds to go back',
        content: {
          'application/json': {
            schema: GoBackSchema,
          },
        },
      },
    },
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),

  goForward: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/go-forward`,
    summary: 'go forward',
    description: 'Move the current song forward by a number of seconds',
    request: {
      body: {
        description: 'seconds to go forward',
        content: {
          'application/json': {
            schema: GoForwardScheme,
          },
        },
      },
    },
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  getShuffleState: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/shuffle`,
    summary: 'get shuffle state',
    description: 'Get the current shuffle state',
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: z.object({
              state: z.boolean().nullable(),
            }),
          },
        },
      },
      ...pageSilent,
    },
  }),
  shuffle: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/shuffle`,
    summary: 'shuffle',
    description: 'Shuffle the queue',
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  repeatMode: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/repeat-mode`,
    summary: 'get current repeat mode',
    description: 'Get the current repeat mode (NONE, ALL, ONE)',
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: z.object({
              mode: z.enum(['ONE', 'NONE', 'ALL']).nullable(),
            }),
          },
        },
      },
    },
  }),
  switchRepeat: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/switch-repeat`,
    summary: 'switch repeat',
    description: 'Switch the repeat mode',
    request: {
      body: {
        description: 'number of times to click the repeat button',
        content: {
          'application/json': {
            schema: SwitchRepeatSchema,
          },
        },
      },
    },
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  setVolume: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/volume`,
    summary: 'set volume',
    description: 'Set the volume of the player',
    request: {
      body: {
        description: 'volume to set',
        content: {
          'application/json': {
            schema: SetVolumeSchema,
          },
        },
      },
    },
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  getVolumeState: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/volume`,
    summary: 'get volume state',
    description: 'Get the current volume state of the player',
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: z.object({
              state: z.number(),
              isMuted: z.boolean(),
            }),
          },
        },
      },
    },
  }),
  setFullscreen: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/fullscreen`,
    summary: 'set fullscreen',
    description: 'Set the fullscreen state of the player',
    request: {
      body: {
        description: 'fullscreen state',
        content: {
          'application/json': {
            schema: SetFullscreenSchema,
          },
        },
      },
    },
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  toggleMute: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/toggle-mute`,
    summary: 'toggle mute',
    description: 'Toggle the mute state of the player',
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),

  getFullscreenState: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/fullscreen`,
    summary: 'get fullscreen state',
    description: 'Get the current fullscreen state',
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: z.object({
              state: z.boolean(),
            }),
          },
        },
      },
      ...pageSilent,
    },
  }),
  oldQueueInfo: createRoute({
    deprecated: true,
    method: 'get',
    path: `/api/${API_VERSION}/queue-info`,
    summary: 'get current queue info',
    description: 'Get the current queue info',
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: z.object({}),
          },
        },
      },
      204: {
        description: 'No queue info',
      },
      ...pageSilent,
    },
  }),
  oldSongInfo: createRoute({
    deprecated: true,
    method: 'get',
    path: `/api/${API_VERSION}/song-info`,
    summary: 'get current song info',
    description: 'Get the current song info',
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: SongInfoSchema,
          },
        },
      },
      204: {
        description: 'No song info',
      },
    },
  }),
  songInfo: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/song`,
    summary: 'get current song info',
    description: 'Get the current song info',
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: SongInfoSchema,
          },
        },
      },
      204: {
        description: 'No song info',
      },
    },
  }),
  nextSongInfo: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/queue/next`,
    summary: 'get next song info',
    description:
      'Get information about the next song in the queue (relative index +1)',
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: SongInfoSchema,
          },
        },
      },
      204: {
        description: 'No next song in queue',
      },
      ...pageSilent,
    },
  }),
  songCover: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/song/cover`,
    summary: 'get the current cover',
    description: "The current song's cover as PNG",
    responses: {
      200: {
        description: 'Success',
        content: {
          'image/png': { schema: z.string().openapi({ format: 'binary' }) },
        },
      },
      204: {
        description: 'No song or no cover',
      },
    },
  }),
  queueItems: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/queue/items`,
    summary: 'get the queue as plain items',
    description:
      'The queue as plain items, the same as the browse routes give, with the index of the song that plays',
    responses: {
      200: {
        description: 'Success',
        content: { 'application/json': { schema: QueueItemsSchema } },
      },
      ...pageSilent,
    },
  }),
  playerState: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/player-state`,
    summary: 'compare the player with the song info',
    description:
      "What the page's player itself plays, the queue's selected song and the page's video elements, next to the song info Rien keeps, to tell when they drift apart",
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: z.object({ page: z.unknown(), song: z.unknown() }),
          },
        },
      },
      ...pageSilent,
    },
  }),

  queueInfo: createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/queue`,
    summary: 'get current queue info',
    description: 'Get the current queue info',
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: z.object({}),
          },
        },
      },
      204: {
        description: 'No queue info',
      },
      ...pageSilent,
    },
  }),
  addSongToQueue: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/queue`,
    summary: 'add song to queue',
    description: 'Add a song to the queue',
    request: {
      body: {
        description: 'video id of the song to add',
        content: {
          'application/json': {
            schema: AddSongToQueueSchema,
          },
        },
      },
    },
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  moveSongInQueue: createRoute({
    method: 'patch',
    path: `/api/${API_VERSION}/queue/{index}`,
    summary: 'move song in queue',
    description: 'Move a song in the queue',
    request: {
      params: QueueParamsSchema,
      body: {
        description: 'index to move the song to',
        content: {
          'application/json': {
            schema: MoveSongInQueueSchema,
          },
        },
      },
    },
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  removeSongFromQueue: createRoute({
    method: 'delete',
    path: `/api/${API_VERSION}/queue/{index}`,
    summary: 'remove song from queue',
    description: 'Remove a song from the queue',
    request: {
      params: QueueParamsSchema,
    },
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  setQueueIndex: createRoute({
    method: 'patch',
    path: `/api/${API_VERSION}/queue`,
    summary: 'set queue index',
    description: 'Set the current index of the queue',
    request: {
      body: {
        description: 'index to move the song to',
        content: {
          'application/json': {
            schema: SetQueueIndexSchema,
          },
        },
      },
    },
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  clearQueue: createRoute({
    method: 'delete',
    path: `/api/${API_VERSION}/queue`,
    summary: 'clear queue',
    description: 'Clear the queue',
    responses: {
      204: {
        description: 'Success',
      },
    },
  }),
  search: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/search`,
    summary: 'search for a song',
    description: 'search for a song',
    request: {
      body: {
        description: 'search query',
        content: {
          'application/json': {
            schema: SearchSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: z.object({}),
          },
        },
      },
    },
  }),
};

type PromiseOrValue<T> = T | Promise<T>;

export const register = (
  app: HonoApp,
  { window }: BackendContext<APIServerConfig>,
  songInfoGetter: () => PromiseOrValue<SongInfo | undefined>,
  repeatModeGetter: () => PromiseOrValue<RepeatMode | undefined>,
  likeTypeGetter: () => PromiseOrValue<LikeType | undefined>,
  volumeStateGetter: () => PromiseOrValue<VolumeState | undefined>,
) => {
  const controller = getSongControls(window);

  app.openapi(routes.previous, (ctx) => {
    controller.previous();

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.next, (ctx) => {
    controller.next();

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.play, (ctx) => {
    controller.play();

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.pause, (ctx) => {
    controller.pause();

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.togglePlay, (ctx) => {
    controller.playPause();

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.getLikeState, async (ctx) => {
    ctx.status(200);
    return ctx.json({ state: (await likeTypeGetter()) ?? null });
  });
  app.openapi(routes.like, (ctx) => {
    controller.like();

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.dislike, (ctx) => {
    controller.dislike();

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.seekTo, (ctx) => {
    const { seconds } = ctx.req.valid('json');
    controller.seekTo(seconds);

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.goBack, (ctx) => {
    const { seconds } = ctx.req.valid('json');
    controller.goBack(seconds);

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.goForward, (ctx) => {
    const { seconds } = ctx.req.valid('json');
    controller.goForward(seconds);

    ctx.status(204);
    return ctx.body(null);
  });

  app.openapi(routes.getShuffleState, async (ctx) => {
    const shuffle = await fromPage<boolean | undefined>(
      'peard:get-shuffle-response',
      () => controller.requestShuffleInformation(),
    );
    if (!shuffle) return ctx.json(noAnswer, 503);
    return ctx.json({ state: !!shuffle.answer }, 200);
  });

  app.openapi(routes.shuffle, (ctx) => {
    controller.shuffle();

    ctx.status(204);
    return ctx.body(null);
  });

  app.openapi(routes.repeatMode, async (ctx) => {
    ctx.status(200);
    return ctx.json({ mode: (await repeatModeGetter()) ?? null });
  });
  app.openapi(routes.switchRepeat, (ctx) => {
    const { iteration } = ctx.req.valid('json');
    controller.switchRepeat(iteration);

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.setVolume, (ctx) => {
    const { volume } = ctx.req.valid('json');
    controller.setVolume(volume);

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.getVolumeState, async (ctx) => {
    ctx.status(200);
    return ctx.json(
      (await volumeStateGetter()) ?? { state: 0, isMuted: false },
    );
  });
  app.openapi(routes.setFullscreen, (ctx) => {
    const { state } = ctx.req.valid('json');
    controller.setFullscreen(state);

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.toggleMute, (ctx) => {
    controller.muteUnmute();

    ctx.status(204);
    return ctx.body(null);
  });

  app.openapi(routes.getFullscreenState, async (ctx) => {
    const fullscreen = await fromPage<boolean | undefined>(
      'peard:set-fullscreen',
      () => controller.requestFullscreenInformation(),
    );
    if (!fullscreen) return ctx.json(noAnswer, 503);
    return ctx.json({ state: !!fullscreen.answer }, 200);
  });

  const songInfo = async (ctx: Context) => {
    const info = await songInfoGetter();

    if (!info) {
      ctx.status(204);
      return ctx.body(null);
    }

    const body = { ...info };
    delete body.image;

    ctx.status(200);
    return ctx.json(body satisfies ResponseSongInfo);
  };
  app.openapi(routes.oldSongInfo, songInfo);
  app.openapi(routes.songInfo, songInfo);
  app.openapi(routes.songCover, async (ctx) => {
    const png = (await songInfoGetter())?.image?.toPNG();
    if (!png?.length) {
      ctx.status(204);
      return ctx.body(null);
    }
    ctx.header('Content-Type', 'image/png');
    return ctx.body(new Uint8Array(png), 200);
  });

  // Read-only: what the page's player plays, beside the song info
  const readPlayer = `(() => {
    const player = document.querySelector('#movie_player');
    const data = player?.getVideoData?.();
    const queue = document.querySelector('#queue')?.queue?.store?.store?.getState?.().queue;
    const song = (item) => item && (item.playlistPanelVideoRenderer ?? item.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer);
    const items = queue?.items ?? [];
    const selected = items.findIndex((item) => song(item)?.selected);
    return {
      player: { videoId: data?.video_id ?? null, title: data?.title ?? null, time: player?.getCurrentTime?.() ?? null, duration: player?.getDuration?.() ?? null, state: player?.getPlayerState?.() ?? null, ad: !!player?.classList.contains('ad-showing') },
      queue: { length: items.length, selected, selectedId: song(items[selected])?.videoId ?? null },
      videos: [...document.querySelectorAll('video')].map((video) => ({ time: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null, paused: video.paused, ended: video.ended, inPlayer: !!player?.contains(video) })),
      path: location.pathname + location.search,
    };
  })()`;
  app.openapi(routes.playerState, async (ctx) => {
    const page: unknown = await within(
      window.webContents.executeJavaScript(readPlayer).catch(() => null),
      5_000,
      null,
    );
    if (!page) return ctx.json(noAnswer, 503);
    const info = await songInfoGetter();
    const song = info && {
      title: info.title,
      videoId: info.videoId,
      elapsedSeconds: info.elapsedSeconds,
      songDuration: info.songDuration,
      isPaused: info.isPaused,
    };
    return ctx.json({ page, song: song ?? null }, 200);
  });

  // Queue
  const askQueue = () =>
    fromPage<QueueResponse | undefined>('peard:get-queue-response', () =>
      controller.requestQueueInformation(),
    );
  const queueInfo = async (ctx: Context) => {
    const asked = await askQueue();
    if (!asked) return ctx.json(noAnswer, 503);
    const info = asked.answer;

    if (!info) {
      ctx.status(204);
      return ctx.body(null);
    }

    ctx.status(200);
    return ctx.json(info);
  };
  app.openapi(routes.oldQueueInfo, queueInfo);
  app.openapi(routes.queueInfo, queueInfo);

  app.openapi(routes.queueItems, async (ctx) => {
    const asked = await askQueue();
    if (!asked) return ctx.json(noAnswer, 503);
    return ctx.json(parseQueue((asked.answer ?? {}) as Json), 200);
  });

  app.openapi(routes.nextSongInfo, async (ctx) => {
    const asked = await askQueue();
    if (!asked) return ctx.json(noAnswer, 503);
    const queue = asked.answer;

    if (!queue?.items || queue.items.length === 0) {
      ctx.status(204);
      return ctx.body(null);
    }

    // Find the currently selected song
    const currentIndex = queue.items.findIndex((item) => {
      const renderer =
        item.playlistPanelVideoRenderer ||
        item.playlistPanelVideoWrapperRenderer?.primaryRenderer
          ?.playlistPanelVideoRenderer;
      return renderer?.selected === true;
    });

    // Get the next song (currentIndex + 1)
    const nextIndex = currentIndex + 1;
    if (nextIndex >= queue.items.length) {
      // No next song available
      ctx.status(204);
      return ctx.body(null);
    }

    const nextItem = queue.items[nextIndex];
    const nextRenderer =
      nextItem.playlistPanelVideoRenderer ||
      nextItem.playlistPanelVideoWrapperRenderer?.primaryRenderer
        ?.playlistPanelVideoRenderer;

    if (!nextRenderer) {
      ctx.status(204);
      return ctx.body(null);
    }

    // Extract relevant information similar to SongInfo format
    const nextSongInfo = {
      title: nextRenderer.title?.runs?.[0]?.text,
      videoId: nextRenderer.videoId,
      thumbnail: nextRenderer.thumbnail,
      lengthText: nextRenderer.lengthText,
      shortBylineText: nextRenderer.shortBylineText,
    };

    ctx.status(200);
    return ctx.json(nextSongInfo);
  });

  app.openapi(routes.addSongToQueue, (ctx) => {
    const { videoId, videoIds, insertPosition } = ctx.req.valid('json');
    controller.addSongToQueue(videoIds ?? [videoId!], insertPosition);

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.moveSongInQueue, (ctx) => {
    const index = Number(ctx.req.param('index'));
    const { toIndex } = ctx.req.valid('json');
    controller.moveSongInQueue(index, toIndex);

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.removeSongFromQueue, (ctx) => {
    const index = Number(ctx.req.param('index'));
    controller.removeSongFromQueue(index);

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.setQueueIndex, (ctx) => {
    const { index } = ctx.req.valid('json');
    controller.setQueueIndex(index);

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.clearQueue, (ctx) => {
    controller.clearQueue();

    ctx.status(204);
    return ctx.body(null);
  });
  app.openapi(routes.search, async (ctx) => {
    const { query, params, continuation } = ctx.req.valid('json');
    const response = await controller.search(query, params, continuation);

    ctx.status(200);
    return ctx.json(response as object);
  });
};

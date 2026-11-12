import { z } from '@hono/zod-openapi';

const RefSchema = z.object({ id: z.string().nullable(), name: z.string() });

export const ItemSchema = z
  .object({
    type: z.enum([
      'song',
      'video',
      'episode',
      'album',
      'artist',
      'playlist',
      'podcast',
      'profile',
    ]),
    id: z.string().openapi({
      description:
        'A video ID for songs, videos and episodes, a browse ID for the rest',
    }),
    title: z.string(),
    subtitle: z.string().openapi({
      description: 'The line under the title, as the site shows it',
    }),
    artists: z.array(RefSchema),
    album: RefSchema.nullable(),
    duration: z.number().nullable().openapi({ description: 'Seconds' }),
    thumbnail: z.string().nullable(),
    playlistId: z.string().nullable().openapi({
      description:
        "The list that plays it: an album's or a playlist's, or the one a song sits in",
    }),
    slot: z.string().nullable().openapi({
      description: "The song's place in a playlist (playlistSetVideoId)",
    }),
    available: z.boolean(),
  })
  .openapi('Item');

const Continuation = z.string().nullable().openapi({
  description:
    'Pass it back as `continuation` for the next page; null on the last one',
});

export const SearchPageSchema = z.object({
  items: z.array(ItemSchema),
  continuation: Continuation,
});

export const QueueItemsSchema = z.object({
  items: z.array(ItemSchema),
  current: z.number().nullable().openapi({
    description: 'The index of the song that plays',
  }),
});

export const SearchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  filter: z
    .enum(['all', 'songs', 'videos', 'albums', 'artists', 'playlists'])
    .default('all'),
  continuation: z.string().max(4000).optional(),
});

export const BrowseIdSchema = z.object({
  id: z.string().regex(/^[\w-]{2,200}$/),
});

export const ContinuationQuerySchema = z.object({
  continuation: z.string().max(4000).optional(),
});

export const AlbumPageSchema = z.object({
  album: z.object({
    id: z.string(),
    title: z.string(),
    subtitle: z.string(),
    artists: z.array(RefSchema),
    year: z.string().nullable(),
    stats: z.string().openapi({
      description: 'Song count and length, as the site shows them',
    }),
    thumbnail: z.string().nullable(),
    playlistId: z.string().nullable(),
  }),
  tracks: z.array(ItemSchema),
});

export const ArtistPageSchema = z.object({
  artist: z.object({
    id: z.string(),
    name: z.string(),
    stats: z.string(),
    thumbnail: z.string().nullable(),
  }),
  sections: z.array(
    z.object({
      title: z.string(),
      items: z.array(ItemSchema),
      more: z.string().nullable().openapi({
        description:
          "The browse ID of the page with all of them, such as the playlist of an artist's songs",
      }),
    }),
  ),
});

export const PlaylistPageSchema = z.object({
  playlist: z
    .object({
      id: z.string(),
      title: z.string(),
      subtitle: z.string(),
      author: RefSchema.nullable(),
      stats: z.string(),
      thumbnail: z.string().nullable(),
    })
    .nullable()
    .openapi({ description: 'Null on the pages after the first' }),
  tracks: z.array(ItemSchema),
  continuation: Continuation,
});

const VideoId = z.string().regex(/^[\w-]{11}$/);

export const PlayNowSchema = z
  .object({
    videoId: VideoId.optional(),
    playlistId: z
      .string()
      .regex(/^[\w-]{2,200}$/)
      .optional(),
  })
  .refine((body) => body.videoId || body.playlistId, {
    message: 'videoId, playlistId or both',
  });

export const DownloadSchema = z.object({
  videoId: VideoId.optional().openapi({
    description: 'Defaults to the current song',
  }),
});

export const LyricsSchema = z.object({
  provider: z.string(),
  title: z.string(),
  artists: z.array(z.string()),
  lines: z
    .array(
      z.object({
        timeMs: z.number(),
        durationMs: z.number().nullable().openapi({
          description:
            'Null for the last line, which lasts until the song ends',
        }),
        text: z.string(),
      }),
    )
    .nullable()
    .openapi({
      description: 'Synced lines; null when only plain lyrics exist',
    }),
  plain: z.string().nullable(),
});

export const ErrorSchema = z.object({ error: z.string() });

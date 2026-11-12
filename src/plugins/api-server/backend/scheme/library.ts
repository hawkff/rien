import { z } from '@hono/zod-openapi';

const VideoId = z.string().regex(/^[\w-]{11}$/);
const PlaylistId = z
  .string()
  .regex(/^[\w-]{2,200}$/)
  .openapi({ description: 'A playlist ID, or its browse ID (VL…)' });

export const FeedbackSchema = z.object({
  tokens: z.array(z.string().min(1).max(1000)).min(1).max(200).openapi({
    description:
      "Tokens from items' `library.add` or `library.remove`, or from history rows",
  }),
});

export const FeedbackResultSchema = z.object({
  processed: z.array(z.boolean()).openapi({
    description: 'Whether the site took each token, in their order',
  }),
});

export const LikeSchema = z
  .object({
    videoId: VideoId.optional(),
    playlistId: PlaylistId.optional(),
    status: z.enum(['LIKE', 'DISLIKE', 'INDIFFERENT']),
  })
  .refine(
    (body) => (body.videoId === undefined) !== (body.playlistId === undefined),
    {
      message: 'Give either videoId or playlistId',
    },
  )
  .openapi({
    description:
      'A song to like, dislike or clear, or an album or playlist (by its playlist ID) to save to the library (LIKE) or remove from it (INDIFFERENT)',
  });

export const PlaylistParamSchema = z.object({ id: PlaylistId });

export const AddToPlaylistSchema = z.object({
  videoIds: z.array(VideoId).min(1).max(200),
  duplicates: z.boolean().default(false).openapi({
    description: 'Add songs that are in the playlist already',
  }),
});

export const AddedSchema = z.object({
  slots: z.array(z.string().nullable()).openapi({
    description:
      "Each added song's slot (playlistSetVideoId), which removes it again",
  }),
});

export const RemoveFromPlaylistSchema = z.object({
  items: z
    .array(
      z.object({
        videoId: VideoId,
        slot: z.string().min(1).max(100).openapi({
          description: "The song's slot, from the playlist's items",
        }),
      }),
    )
    .min(1)
    .max(200),
});

export const CreatePlaylistSchema = z.object({
  title: z.string().min(1).max(150),
  description: z.string().max(5000).default(''),
  privacy: z.enum(['PRIVATE', 'UNLISTED', 'PUBLIC']).default('PRIVATE'),
  videoIds: z.array(VideoId).max(200).default([]),
});

export const CreatedPlaylistSchema = z.object({ id: z.string() });

import { z } from '@hono/zod-openapi';

export const QueueParamsSchema = z.object({
  index: z.coerce.number().int().nonnegative(),
});

export const AddSongToQueueSchema = z
  .object({
    videoId: z.string().optional(),
    videoIds: z.array(z.string()).min(1).max(200).optional().openapi({
      description: 'Several songs at once, kept in this order',
    }),
    insertPosition: z
      .enum(['INSERT_AT_END', 'INSERT_AFTER_CURRENT_VIDEO'])
      .optional()
      .default('INSERT_AT_END'),
  })
  .refine((body) => body.videoId || body.videoIds, {
    message: 'videoId or videoIds',
  });
export const MoveSongInQueueSchema = z.object({
  toIndex: z.number(),
});
export const SetQueueIndexSchema = z.object({
  index: z.number().int().nonnegative(),
});

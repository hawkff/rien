import { createRoute } from '@hono/zod-openapi';

import { API_VERSION } from '../api-version';
import {
  addedSlots,
  addRequest,
  createdId,
  createRequest,
  deleteRequest,
  deleteSucceeded,
  editSucceeded,
  feedbackRequest,
  likeRequest,
  processedOf,
  removeRequest,
} from '../library';
import { askPage, pageSignedIn } from '../page';
import { ErrorSchema } from '../scheme/browse';
import {
  AddedSchema,
  AddToPlaylistSchema,
  CreatedPlaylistSchema,
  CreatePlaylistSchema,
  FeedbackResultSchema,
  FeedbackSchema,
  LikeSchema,
  PlaylistParamSchema,
  RemoveFromPlaylistSchema,
} from '../scheme/library';

import type { APIServerConfig } from '../../config';
import type { HonoApp } from '../types';
import type { BackendContext } from '@/types/contexts';

const json = <T>(schema: T, description = 'Success') => ({
  description,
  content: { 'application/json': { schema } },
});
const body = <T>(schema: T) => ({
  body: {
    content: { 'application/json': { schema } },
    required: true,
  },
});
// What every change can answer besides success
const failures = {
  409: json(ErrorSchema, 'Rien is not signed in'),
  502: json(ErrorSchema, 'The site refused the change'),
  503: json(ErrorSchema, 'The page could not answer'),
};

const routes = {
  feedback: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/library/feedback`,
    summary: 'save to or remove from the library',
    description:
      "Sends the tokens of items' menus: `library.add` saves an item to the library, `library.remove` removes it, and a history row's token removes it from the history.",
    request: body(FeedbackSchema),
    responses: { 200: json(FeedbackResultSchema), ...failures },
  }),
  like: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/library/rate`,
    summary: 'like, dislike or clear',
    description:
      'Rates a song, or saves an album or playlist to the library (LIKE) and removes it (INDIFFERENT).',
    request: body(LikeSchema),
    responses: { 204: { description: 'Success' }, ...failures },
  }),
  create: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/playlists`,
    summary: 'create a playlist',
    description: 'Makes a playlist, private by default, with songs if given.',
    request: body(CreatePlaylistSchema),
    responses: { 200: json(CreatedPlaylistSchema), ...failures },
  }),
  add: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/playlists/{id}/add`,
    summary: 'add songs to a playlist',
    description:
      'Adds songs to the end of a playlist, in order. Without `duplicates`, the site refuses a request with a song that is in the playlist already.',
    request: { params: PlaylistParamSchema, ...body(AddToPlaylistSchema) },
    responses: {
      200: json(AddedSchema),
      400: json(
        ErrorSchema,
        'A song is in the request twice without duplicates',
      ),
      ...failures,
    },
  }),
  remove: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/playlists/{id}/remove`,
    summary: 'remove songs from a playlist',
    description: "Removes songs by their slots, from the playlist's items.",
    request: { params: PlaylistParamSchema, ...body(RemoveFromPlaylistSchema) },
    responses: { 204: { description: 'Success' }, ...failures },
  }),
  delete: createRoute({
    method: 'delete',
    path: `/api/${API_VERSION}/playlists/{id}`,
    summary: 'delete a playlist',
    description: "Deletes one of the account's playlists.",
    request: { params: PlaylistParamSchema },
    responses: { 204: { description: 'Success' }, ...failures },
  }),
};

export const register = (
  app: HonoApp,
  { window }: BackendContext<APIServerConfig>,
) => {
  const signedOut = { error: 'Rien is not signed in' };
  // A change can go through after the page stopped waiting for it
  const noAnswer = {
    error:
      "The page didn't answer in time; the change may have gone through, so check before trying again",
  };
  const refused = { error: 'The site refused the change' };
  // Sends a change through the page; undefined when Rien is signed out
  const send = async ([endpoint, request]: readonly [string, object]) =>
    (await pageSignedIn(window)) === false
      ? undefined
      : askPage(window, endpoint, request);

  app.openapi(routes.feedback, async (ctx) => {
    const { tokens } = ctx.req.valid('json');
    const answer = await send(feedbackRequest(tokens));
    if (answer === undefined) return ctx.json(signedOut, 409);
    if (!answer) return ctx.json(noAnswer, 503);
    return ctx.json({ processed: processedOf(answer, tokens.length) }, 200);
  });

  app.openapi(routes.like, async (ctx) => {
    const { videoId, playlistId, status } = ctx.req.valid('json');
    const target = videoId ? { videoId } : { playlistId: playlistId! };
    const answer = await send(likeRequest(target, status));
    if (answer === undefined) return ctx.json(signedOut, 409);
    if (!answer) return ctx.json(noAnswer, 503);
    ctx.status(204);
    return ctx.body(null);
  });

  app.openapi(routes.create, async (ctx) => {
    const { title, description, privacy, videoIds } = ctx.req.valid('json');
    const answer = await send(
      createRequest(title, description, privacy, videoIds),
    );
    if (answer === undefined) return ctx.json(signedOut, 409);
    if (!answer) return ctx.json(noAnswer, 503);
    const id = createdId(answer);
    if (!id) return ctx.json(refused, 502);
    return ctx.json({ id }, 200);
  });

  app.openapi(routes.add, async (ctx) => {
    const { id } = ctx.req.valid('param');
    const { videoIds, duplicates } = ctx.req.valid('json');
    if (!duplicates && new Set(videoIds).size < videoIds.length) {
      return ctx.json(
        { error: 'A song is in the request twice; send duplicates: true' },
        400,
      );
    }
    const answer = await send(addRequest(id, videoIds, duplicates));
    if (answer === undefined) return ctx.json(signedOut, 409);
    if (!answer) return ctx.json(noAnswer, 503);
    if (!editSucceeded(answer)) return ctx.json(refused, 502);
    return ctx.json({ slots: addedSlots(answer, videoIds) }, 200);
  });

  app.openapi(routes.remove, async (ctx) => {
    const { id } = ctx.req.valid('param');
    const { items } = ctx.req.valid('json');
    const answer = await send(removeRequest(id, items));
    if (answer === undefined) return ctx.json(signedOut, 409);
    if (!answer) return ctx.json(noAnswer, 503);
    if (!editSucceeded(answer)) return ctx.json(refused, 502);
    ctx.status(204);
    return ctx.body(null);
  });

  app.openapi(routes.delete, async (ctx) => {
    const { id } = ctx.req.valid('param');
    const answer = await send(deleteRequest(id));
    if (answer === undefined) return ctx.json(signedOut, 409);
    if (!answer) return ctx.json(noAnswer, 503);
    if (!deleteSucceeded(answer)) return ctx.json(refused, 502);
    ctx.status(204);
    return ctx.body(null);
  });
};

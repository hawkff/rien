// The requests that change the account's library, as the site's own pages
// send them, and what their answers say.
import type { Json } from './browse';

const object = (value: Json | undefined) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
const array = (value: Json | undefined) => (Array.isArray(value) ? value : []);

export type LikeStatus = 'LIKE' | 'DISLIKE' | 'INDIFFERENT';

// The site's edit and delete calls take a playlist ID, not its browse ID
export const playlistIdOf = (id: string) =>
  id.startsWith('VL') ? id.slice(2) : id;

/** Saves to or removes from the library, or removes from the history, by the tokens of the items' menus */
export const feedbackRequest = (tokens: string[]) =>
  ['/feedback', { feedbackTokens: tokens }] as const;

/** Whether the site took each token, in their order */
export const processedOf = (answer: Json, count: number) => {
  const responses = array(object(answer)?.feedbackResponses);
  return Array.from(
    { length: count },
    (_, index) => object(responses[index])?.isProcessed === true,
  );
};

/** Likes, dislikes or clears a song, or saves an album or playlist to the library (LIKE) and removes it (INDIFFERENT) */
export const likeRequest = (
  target: { videoId: string } | { playlistId: string },
  status: LikeStatus,
) =>
  [
    status === 'LIKE'
      ? '/like/like'
      : status === 'DISLIKE'
        ? '/like/dislike'
        : '/like/removelike',
    {
      target:
        'playlistId' in target
          ? { playlistId: playlistIdOf(target.playlistId) }
          : target,
    },
  ] as const;

/** Adds songs to the end of a playlist; with `duplicates`, songs already in it go in again */
export const addRequest = (
  playlistId: string,
  videoIds: string[],
  duplicates: boolean,
) =>
  [
    '/browse/edit_playlist',
    {
      playlistId: playlistIdOf(playlistId),
      actions: videoIds.map((videoId) => ({
        action: 'ACTION_ADD_VIDEO',
        addedVideoId: videoId,
        // The site's name for adding without its duplicate check
        ...(duplicates ? { dedupeOption: 'DEDUPE_OPTION_SKIP' } : {}),
      })),
    },
  ] as const;

/** Removes songs from a playlist by their slots */
export const removeRequest = (
  playlistId: string,
  items: { videoId: string; slot: string }[],
) =>
  [
    '/browse/edit_playlist',
    {
      playlistId: playlistIdOf(playlistId),
      actions: items.map(({ videoId, slot }) => ({
        action: 'ACTION_REMOVE_VIDEO',
        removedVideoId: videoId,
        setVideoId: slot,
      })),
    },
  ] as const;

/** Whether the site made the edit */
export const editSucceeded = (answer: Json) =>
  object(answer)?.status === 'STATUS_SUCCEEDED';

/** Whether a deletion went through: an answer with a status must say so */
export const deleteSucceeded = (answer: Json) => {
  const status = object(answer)?.status;
  return status === undefined || status === 'STATUS_SUCCEEDED';
};

/** The slot of each added song, which removes it again; null where the site names none */
export const addedSlots = (answer: Json, videoIds: string[]) => {
  const added = array(object(answer)?.playlistEditResults)
    .map((result) =>
      object(object(result)?.playlistEditVideoAddedResultData ?? null),
    )
    .filter((result) => result !== undefined);
  // In order of the request, a song that goes in twice taking the next slot
  const used = new Set<number>();
  return videoIds.map((videoId) => {
    const index = added.findIndex(
      (result, at) => !used.has(at) && result.videoId === videoId,
    );
    if (index < 0) return null;
    used.add(index);
    const slot = added[index].setVideoId;
    return typeof slot === 'string' ? slot : null;
  });
};

export type Privacy = 'PRIVATE' | 'UNLISTED' | 'PUBLIC';

/** Makes a playlist, with songs in it if given */
export const createRequest = (
  title: string,
  description: string,
  privacy: Privacy,
  videoIds: string[],
) =>
  [
    '/playlist/create',
    {
      title,
      description,
      privacyStatus: privacy,
      ...(videoIds.length ? { videoIds } : {}),
    },
  ] as const;

/** The new playlist's ID */
export const createdId = (answer: Json) => {
  const id = object(answer)?.playlistId;
  return typeof id === 'string' ? id : null;
};

/** Deletes one of the account's playlists */
export const deleteRequest = (playlistId: string) =>
  ['/playlist/delete', { playlistId: playlistIdOf(playlistId) }] as const;

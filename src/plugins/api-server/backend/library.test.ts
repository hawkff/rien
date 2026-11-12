import { test, expect } from '@playwright/test';

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
} from './library';

test('library tokens go out as feedback, and each one reports back', () => {
  expect(feedbackRequest(['a', 'b'])).toEqual([
    '/feedback',
    { feedbackTokens: ['a', 'b'] },
  ]);
  expect(
    processedOf({ feedbackResponses: [{ isProcessed: true }, {}] }, 3),
  ).toEqual([true, false, false]);
});

test('likes rate songs, and save albums and playlists by their playlist ID', () => {
  expect(likeRequest({ videoId: 'aaaaaaaaaaa' }, 'LIKE')).toEqual([
    '/like/like',
    { target: { videoId: 'aaaaaaaaaaa' } },
  ]);
  expect(likeRequest({ videoId: 'aaaaaaaaaaa' }, 'DISLIKE')[0]).toBe(
    '/like/dislike',
  );
  expect(likeRequest({ playlistId: 'VLPLxyz' }, 'INDIFFERENT')).toEqual([
    '/like/removelike',
    { target: { playlistId: 'PLxyz' } },
  ]);
});

test('playlist edits name the playlist without VL, and adds keep their order', () => {
  expect(addRequest('VLPLxyz', ['aaaaaaaaaaa', 'bbbbbbbbbbb'], false)).toEqual([
    '/browse/edit_playlist',
    {
      playlistId: 'PLxyz',
      actions: [
        { action: 'ACTION_ADD_VIDEO', addedVideoId: 'aaaaaaaaaaa' },
        { action: 'ACTION_ADD_VIDEO', addedVideoId: 'bbbbbbbbbbb' },
      ],
    },
  ]);
  expect(addRequest('PLxyz', ['aaaaaaaaaaa'], true)[1].actions[0]).toEqual({
    action: 'ACTION_ADD_VIDEO',
    addedVideoId: 'aaaaaaaaaaa',
    dedupeOption: 'DEDUPE_OPTION_SKIP',
  });
  expect(
    removeRequest('PLxyz', [{ videoId: 'aaaaaaaaaaa', slot: 'S1' }]),
  ).toEqual([
    '/browse/edit_playlist',
    {
      playlistId: 'PLxyz',
      actions: [
        {
          action: 'ACTION_REMOVE_VIDEO',
          removedVideoId: 'aaaaaaaaaaa',
          setVideoId: 'S1',
        },
      ],
    },
  ]);
  expect(editSucceeded({ status: 'STATUS_SUCCEEDED' })).toBe(true);
  expect(editSucceeded({ status: 'STATUS_FAILED' })).toBe(false);
});

test('added songs get their slots, a song added twice one each', () => {
  const answer = {
    status: 'STATUS_SUCCEEDED',
    playlistEditResults: [
      {
        playlistEditVideoAddedResultData: {
          videoId: 'aaaaaaaaaaa',
          setVideoId: 'S1',
        },
      },
      {
        playlistEditVideoAddedResultData: {
          videoId: 'aaaaaaaaaaa',
          setVideoId: 'S2',
        },
      },
    ],
  };
  expect(
    addedSlots(answer, ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'aaaaaaaaaaa']),
  ).toEqual(['S1', null, 'S2']);
});

test('a playlist is made private by default and deleted by its ID', () => {
  expect(createRequest('Test', '', 'PRIVATE', [])).toEqual([
    '/playlist/create',
    { title: 'Test', description: '', privacyStatus: 'PRIVATE' },
  ]);
  expect(createRequest('Test', 'd', 'UNLISTED', ['aaaaaaaaaaa'])[1]).toEqual({
    title: 'Test',
    description: 'd',
    privacyStatus: 'UNLISTED',
    videoIds: ['aaaaaaaaaaa'],
  });
  expect(createdId({ playlistId: 'PLnew' })).toBe('PLnew');
  expect(createdId({})).toBeNull();
  expect(deleteRequest('VLPLnew')).toEqual([
    '/playlist/delete',
    { playlistId: 'PLnew' },
  ]);
  expect(deleteSucceeded({})).toBe(true);
  expect(deleteSucceeded({ status: 'STATUS_SUCCEEDED' })).toBe(true);
  expect(deleteSucceeded({ status: 'STATUS_FAILED' })).toBe(false);
});

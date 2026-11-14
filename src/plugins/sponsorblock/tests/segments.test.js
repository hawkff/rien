import { test, expect } from '@playwright/test';

import { latestSegments, sortSegments } from '../segments';

test('Segment sorting', () => {
  expect(
    sortSegments([
      [0, 3],
      [7, 8],
      [5, 6],
    ]),
  ).toEqual([
    [0, 3],
    [5, 6],
    [7, 8],
  ]);

  expect(
    sortSegments([
      [0, 5],
      [6, 8],
      [4, 6],
    ]),
  ).toEqual([[0, 8]]);

  expect(
    sortSegments([
      [0, 6],
      [7, 8],
      [4, 6],
    ]),
  ).toEqual([
    [0, 6],
    [7, 8],
  ]);
});

test('A late answer for an earlier video is dropped', async () => {
  const delivered = [];
  const onVideo = latestSegments(
    async (videoId) => {
      if (videoId === 'second') return [[20, 40]];
      // The first video's answer takes longer than the second's.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [[0, 60]];
    },
    (segments) => delivered.push(segments),
  );

  await Promise.all([onVideo('first'), onVideo('second')]);

  expect(delivered).toEqual([[[20, 40]]]);
});

test('A video that starts again is asked for once', async () => {
  let asked = 0;
  const delivered = [];
  const onVideo = latestSegments(
    () => {
      asked++;
      return Promise.resolve([[20, 40]]);
    },
    (segments) => delivered.push(segments),
  );

  await Promise.all([onVideo('song'), onVideo('song')]);
  await onVideo('song');

  expect(asked).toBe(1);
  // Each start still gets the segments: the page drops them when its video
  // element empties.
  expect(delivered).toEqual([[[20, 40]], [[20, 40]], [[20, 40]]]);
});

test('A failed answer is asked for again', async () => {
  let asked = 0;
  const delivered = [];
  const onVideo = latestSegments(
    () => {
      asked++;
      return asked === 1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve([[20, 40]]);
    },
    (segments) => delivered.push(segments),
  );

  await onVideo('song');
  await onVideo('song');

  expect(asked).toBe(2);
  expect(delivered).toEqual([[], [[20, 40]]]);
});

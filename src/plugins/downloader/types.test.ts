import { test, expect } from '@playwright/test';

import { containerOf } from './types';

test('names the container of a stream', () => {
  expect(
    containerOf({ mime_type: 'audio/webm; codecs="opus"', has_video: false }),
  ).toBe('webm');
  expect(
    containerOf({
      mime_type: 'audio/mp4; codecs="mp4a.40.2"',
      has_video: false,
    }),
  ).toBe('m4a');
  expect(
    containerOf({
      mime_type: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
      has_video: true,
    }),
  ).toBe('mp4');
});

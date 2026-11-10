// Segments are an array [ [start, end], … ]
import type { Segment } from './types';

export const sortSegments = (segments: Segment[]) => {
  segments.sort((segment1, segment2) =>
    segment1[0] === segment2[0]
      ? segment1[1] - segment2[1]
      : segment1[0] - segment2[0],
  );

  const compiledSegments: Segment[] = [];
  let currentSegment: Segment | undefined;

  for (const segment of segments) {
    if (!currentSegment) {
      currentSegment = segment;
      continue;
    }

    if (currentSegment[1] < segment[0]) {
      compiledSegments.push(currentSegment);
      currentSegment = segment;
      continue;
    }

    currentSegment[1] = Math.max(currentSegment[1], segment[1]);
  }

  if (currentSegment) {
    compiledSegments.push(currentSegment);
  }

  return compiledSegments;
};

// Loads the segments of every video that starts and hands over only those of
// the latest one. The answer for an earlier video can arrive after the next
// video started.
export const latestSegments = (
  load: (videoId: string) => Promise<Segment[]>,
  deliver: (segments: Segment[]) => void,
) => {
  let latestVideoId: string | undefined;
  return async (videoId: string) => {
    latestVideoId = videoId;
    const segments = await load(videoId);
    if (videoId === latestVideoId) deliver(segments);
  };
};

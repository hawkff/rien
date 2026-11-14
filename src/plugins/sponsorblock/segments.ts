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
// video started. The page reports one start up to four times, so the video
// asked for last reuses its answer; a failed answer is asked for again.
export const latestSegments = (
  load: (videoId: string) => Promise<Segment[]>,
  deliver: (segments: Segment[]) => void,
) => {
  let latestVideoId: string | undefined;
  let asked: { videoId: string; answer: Promise<Segment[]> } | undefined;
  return async (videoId: string) => {
    latestVideoId = videoId;
    if (asked?.videoId !== videoId) asked = { videoId, answer: load(videoId) };
    const request = asked;
    const segments = await request.answer.catch(() => {
      if (asked === request) asked = undefined;
      return [];
    });
    if (videoId === latestVideoId) deliver(segments);
  };
};

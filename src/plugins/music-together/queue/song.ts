import type { MusicPlayerAppElement } from '@/types/music-player-app-element';
import type { QueueElement } from '@/types/queue';

type QueueRendererResponse = {
  queueDatas: {
    content: unknown;
  }[];
  responseContext: unknown;
  trackingParams: string;
};

// The room's changes wait for each lookup in turn, so one that hangs would
// hold them all
const LOOKUP_DEADLINE_MS = 10_000;

// null: no answer, a failed one, or none in time
export const getMusicQueueRenderer = async (
  videoIds: string[],
): Promise<QueueRendererResponse | null> => {
  const queue = document.querySelector<QueueElement>('#queue');
  const app = document.querySelector<MusicPlayerAppElement>('ytmusic-app');
  if (!app) return null;

  const store = queue?.queue.store.store;
  if (!store) return null;

  let timer: number | undefined;
  return await Promise.race([
    app.networkManager
      .fetch<
        QueueRendererResponse,
        {
          queueContextParams: string;
          videoIds: string[];
        }
      >('/music/get_queue', {
        queueContextParams: store.getState().queue.queueContextParams,
        videoIds,
      })
      .catch(() => null),
    new Promise<null>((resolve) => {
      timer = window.setTimeout(() => resolve(null), LOOKUP_DEADLINE_MS);
    }),
  ]).finally(() => clearTimeout(timer));
};

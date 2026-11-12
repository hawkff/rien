import type { QueueItem } from '@/types/datahost-get-state';
import type { PlayerOverlays } from '@/types/player-api-events';

export interface QueueResponse {
  items?: QueueItem[];
  autoPlaying?: boolean;
  continuation?: string;
  // The songs the site plays after the queue, while autoplay is on
  automixItems?: unknown[];
}

export interface WatchNextResponse {
  playerOverlays?: PlayerOverlays;
}

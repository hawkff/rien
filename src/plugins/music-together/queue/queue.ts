import { t } from '@/i18n';

import { getMusicQueueRenderer } from './song';
import { mapQueueItem } from './utils';

import { getDefaultProfile, type Profile, type VideoData } from '../types';

import type { ConnectionEventUnion } from '@/plugins/music-together/connection';
import type { QueueItem } from '@/types/datahost-get-state';
import type { QueueElement, Store } from '@/types/queue';

const getHeaderPayload = (() => {
  let payload: {
    items?: QueueItem[] | undefined;
    title: {
      runs: {
        text: string;
      }[];
    };
    subtitle: {
      runs: {
        text: string;
      }[];
    };
    buttons: {
      chipCloudChipRenderer: {
        style: {
          styleType: string;
        };
        text: {
          runs: {
            text: string;
          }[];
        };
        navigationEndpoint: {
          saveQueueToPlaylistCommand: unknown;
        };
        icon: {
          iconType: string;
        };
        accessibilityData: {
          accessibilityData: {
            label: string;
          };
        };
        isSelected: boolean;
        uniqueId: string;
      };
    }[];
  } | null = null;

  return () => {
    if (!payload) {
      payload = {
        title: {
          runs: [
            {
              text: t('plugins.music-together.internal.track-source'),
            },
          ],
        },
        subtitle: {
          runs: [
            {
              text: t('plugins.music-together.name'),
            },
          ],
        },
        buttons: [
          {
            chipCloudChipRenderer: {
              style: {
                styleType: 'STYLE_TRANSPARENT',
              },
              text: {
                runs: [
                  {
                    text: t('plugins.music-together.internal.save'),
                  },
                ],
              },
              navigationEndpoint: {
                saveQueueToPlaylistCommand: {},
              },
              icon: {
                iconType: 'ADD_TO_PLAYLIST',
              },
              accessibilityData: {
                accessibilityData: {
                  label: t('plugins.music-together.internal.save'),
                },
              },
              isSelected: false,
              uniqueId: t('plugins.music-together.internal.save'),
            },
          },
        ],
      };
    }

    return payload;
  };
})();

export type QueueOptions = {
  videoList?: VideoData[];
  owner?: Profile;
  queue?: QueueElement;
  getProfile: (id: string) => Profile | undefined;
};
export type QueueEventListener = (event: ConnectionEventUnion) => void;

export class Queue {
  private readonly queue: QueueElement;

  private originalDispatch?: (obj: {
    type: string;
    payload?: { items?: QueueItem[] | undefined };
  }) => void;

  private internalDispatch = false;
  private ignoreFlag = false;
  private listeners: QueueEventListener[] = [];

  private owner: Profile | null;
  private readonly getProfile: (id: string) => Profile | undefined;

  constructor(options: QueueOptions) {
    this.getProfile = options.getProfile;
    this.queue =
      options.queue ?? document.querySelector<QueueElement>('#queue')!;
    this.owner = options.owner ?? null;
    this._videoList = options.videoList ?? [];
  }

  private _videoList: VideoData[] = [];

  /* utils */
  get videoList() {
    return this._videoList;
  }

  get selectedIndex() {
    return (
      mapQueueItem(
        (it) => it?.selected,
        this.queue.queue.store.store.getState().queue.items,
      ).findIndex(Boolean) ?? 0
    );
  }

  get rawItems() {
    return this.queue?.queue.store.store.getState().queue.items;
  }

  get flatItems() {
    return mapQueueItem((it) => it, this.rawItems);
  }

  setOwner(owner: Profile) {
    this.owner = owner;
  }

  /* public */
  async setVideoList(videoList: VideoData[], sync = true) {
    this._videoList = videoList;

    return sync ? this.syncVideo() : true;
  }

  // Adds land in the order they came, though each fetches its songs first
  private adding = Promise.resolve(true);
  // A new one for each room: the changes of a room left behind are dropped
  private room = {};
  // A guest missed songs the host has, or its whole list: the places the
  // host's changes name are off until its next whole list lands, which holds
  // those changes too
  awaitingList = false;

  // fromHost: a guest taking the host's add, which waits for the host's whole
  // list when the songs can't be had
  addVideos(videos: VideoData[], index?: number, fromHost = false) {
    return this.inTurn(async () => {
      const room = this.room;
      const added = await this.insertVideos(videos, index);
      if (!added && fromHost && this.room === room) this.awaitingList = true;
      return added;
    });
  }

  /**
   * Runs a change from the host after the ones that came before it, adds
   * whose songs are still on their way among them, so that a place it names
   * means what it meant for the host. wholeList: the host's whole list, which
   * runs even while one is awaited, and ends the wait when it lands
   */
  inTurn<T>(step: () => T | Promise<T>, wholeList = false) {
    const room = this.room;
    const done = this.adding.then(async () => {
      if (this.room !== room || (this.awaitingList && !wholeList))
        return undefined;
      const result = await step();
      if (wholeList && this.room === room) this.awaitingList = result === false;
      return result;
    });
    this.adding = done.then(
      () => true,
      () => false,
    );
    return done;
  }

  private async insertVideos(videos: VideoData[], index?: number) {
    const room = this.room;
    const response = await getMusicQueueRenderer(
      videos.map((it) => it.videoId),
    );
    if (!response || this.room !== room) return false;

    const items = response.queueDatas.map((it) => it?.content).filter(Boolean);
    if (!items) return false;

    this.internalDispatch = true;
    this._videoList = this._videoList.map(
      (it) =>
        ({
          videoId: it.videoId,
          ownerId: it.ownerId ?? this.owner!.id,
        }) satisfies VideoData,
    );

    const state = this.queue.queue.store.store.getState();

    this.queue?.dispatch({
      type: 'ADD_ITEMS',
      payload: {
        nextQueueItemId: state.queue.nextQueueItemId,
        index: index ?? state.queue.items.length,
        items,
        shuffleEnabled: false,
        shouldAssignIds: true,
      },
    });

    // Every list, the adder's too, takes the songs here and only here, so
    // owners stay in step with the songs when adds cross on their way
    this._videoList.splice(
      index ?? this._videoList.length,
      0,
      ...videos.map((it) => ({
        ...it,
        ownerId: it.ownerId ?? this.owner?.id,
      })),
    );

    this.internalDispatch = false;
    setTimeout(() => {
      this.initQueue();
      this.syncQueueOwner();
    }, 0);

    return true;
  }

  removeVideo(index: number) {
    this.internalDispatch = true;
    this._videoList.splice(index, 1);
    this.queue?.dispatch({
      type: 'REMOVE_ITEM',
      payload: index,
    });
    this.internalDispatch = false;
    setTimeout(() => {
      this.initQueue();
      this.syncQueueOwner();
    }, 0);
  }

  setIndex(index: number) {
    this.internalDispatch = true;
    this.queue?.dispatch({
      type: 'SET_INDEX',
      payload: index,
    });
    this.internalDispatch = false;
  }

  // The latest song change from the host, which wins over older ones still
  // waiting
  private indexTarget = -1;

  // A song change from the host, in turn with its other changes, so that the
  // index points at the song it meant
  setIndexAfterAdds(index: number) {
    this.indexTarget = index;
    return this.inTurn(() => {
      if (this.indexTarget === index && this.selectedIndex !== index)
        this.setIndex(index);
    });
  }

  moveItem(fromIndex: number, toIndex: number) {
    this.internalDispatch = true;
    const data = this._videoList.splice(fromIndex, 1)[0];
    this._videoList.splice(toIndex, 0, data);
    this.queue?.dispatch({
      type: 'MOVE_ITEM',
      payload: {
        fromIndex,
        toIndex,
      },
    });
    this.internalDispatch = false;
    setTimeout(() => {
      this.initQueue();
      this.syncQueueOwner();
    }, 0);
  }

  clear() {
    this.internalDispatch = true;
    this._videoList = [];
    this.queue?.dispatch({
      type: 'CLEAR',
    });
    this.internalDispatch = false;
  }

  on(listener: QueueEventListener) {
    if (!this.listeners.includes(listener)) {
      this.listeners.push(listener);
    }
  }

  off(listener: QueueEventListener) {
    this.listeners = this.listeners.filter((it) => it !== listener);
  }

  rollbackInjection() {
    // The room is left: its changes still waiting go with it, and the next
    // room's changes don't wait for them
    this.room = {};
    this.adding = Promise.resolve(true);
    this.awaitingList = false;
    if (!this.queue) {
      console.error('Queue is not initialized!');
      return;
    }

    if (this.originalDispatch)
      this.queue.queue.store.store.dispatch =
        this.originalDispatch as Store['dispatch'];
  }

  injection() {
    if (!this.queue) {
      console.error('Queue is not initialized!');
      return;
    }

    this.originalDispatch = this.queue.queue.store.store.dispatch;
    this.queue.queue.store.store.dispatch = (event) => {
      if (!this.queue || !this.owner) {
        console.error('Queue is not initialized!');
        return;
      }

      if (!this.internalDispatch) {
        // A guest waiting for the host's whole list may show places the
        // host's list no longer has: changes that name one are dropped
        if (
          this.awaitingList &&
          ['MOVE_ITEM', 'REMOVE_ITEM', 'SET_INDEX'].includes(event.type)
        )
          return;
        if (event.type === 'CLEAR') {
          this.ignoreFlag = true;
          this.broadcast({
            type: 'CLEAR_QUEUE',
            payload: null,
          });
          return;
        }
        if (event.type === 'ADD_ITEMS') {
          if (this.ignoreFlag) {
            this.ignoreFlag = false;
            const videoList = mapQueueItem(
              (it) =>
                ({
                  videoId: it!.videoId,
                  ownerId: this.owner!.id,
                }) satisfies VideoData,
              (
                event.payload! as {
                  items: QueueItem[];
                }
              ).items,
            );
            if (videoList.length > 0) {
              this.broadcast({
                // play: the new list goes first, before any add that
                // landed in the cleared list while it was on its way
                type: 'ADD_SONGS',
                payload: {
                  index: 0,
                  videoList,
                },
                after: [
                  {
                    type: 'SET_INDEX',
                    payload: {
                      index: 0,
                    },
                  },
                ],
              });
            }
          } else {
            const { items, index, insertPosition } = event.payload as {
              items: QueueItem[];
              index?: number;
              // Rien's own adds say what the user chose
              insertPosition?: string;
            };
            // One song, or songs added at a place of the user's choice, as
            // the site's Add to queue and Play next do; the site adds no list
            // of songs without a place by itself
            if (items.length === 1 || typeof index === 'number') {
              const videoList = mapQueueItem(
                (it) =>
                  ({
                    videoId: it!.videoId,
                    ownerId: this.owner!.id,
                  }) satisfies VideoData,
                items,
              );
              // The place, so that every list puts them at the same one.
              // Songs for the end carry none, unless they play next: each
              // list puts them at its end when they land, after the adds
              // still on their way.
              // Without the choice, the place right after the playing song
              // counts as Play next, the end of the queue as Add to queue;
              // after the last song the two are the same place.
              const place =
                insertPosition === 'INSERT_AT_END'
                  ? undefined
                  : typeof index === 'number' &&
                      (insertPosition === 'INSERT_AFTER_CURRENT_VIDEO' ||
                        index < this._videoList.length ||
                        index === this.selectedIndex + 1)
                    ? index
                    : undefined;
              if (place !== undefined && this.awaitingList) return;
              this.broadcast({
                type: 'ADD_SONGS',
                payload: {
                  index: place,
                  videoList,
                },
              });
            }
          }

          return;
        }

        if (event.type === 'MOVE_ITEM') {
          this.broadcast({
            type: 'MOVE_SONG',
            payload: {
              fromIndex: (
                event.payload as {
                  fromIndex: number;
                }
              ).fromIndex,
              toIndex: (
                event.payload as {
                  toIndex: number;
                }
              ).toIndex,
            },
          });
          return;
        }
        if (event.type === 'REMOVE_ITEM') {
          this.broadcast({
            type: 'REMOVE_SONG',
            payload: {
              index: event.payload as number,
            },
          });
          return;
        }
        if (event.type === 'SET_INDEX') {
          this.broadcast({
            type: 'SYNC_PROGRESS',
            payload: {
              index: event.payload as number,
            },
          });
          return;
        }

        if (event.type === 'SET_HEADER') event.payload = getHeaderPayload();
        if (event.type === 'ADD_STEERING_CHIPS') {
          event.type = 'CLEAR_STEERING_CHIPS';
          event.payload = undefined;
        }
        if (event.type === 'SET_PLAYER_UI_STATE') {
          if (
            (event.payload as string) === 'INACTIVE' &&
            this.videoList.length > 0
          ) {
            return;
          }
        }
        if (event.type === 'HAS_SHOWN_AUTOPLAY') return;
        if (event.type === 'ADD_AUTOMIX_ITEMS') return;
      }

      const fakeContext = {
        ...this.queue,
        queue: {
          ...this.queue.queue,
          store: {
            ...this.queue.queue.store,
            dispatch: this.originalDispatch,
          },
        },
      };
      this.originalDispatch?.call(
        fakeContext,
        event as {
          type: string;
          payload?: { items?: QueueItem[] | undefined } | undefined;
        },
      );
    };
  }

  /* sync */
  initQueue() {
    if (!this.queue) return;

    this.internalDispatch = true;
    this.queue.dispatch({
      type: 'HAS_SHOWN_AUTOPLAY',
      payload: false,
    });
    this.queue.dispatch({
      type: 'SET_HEADER',
      payload: getHeaderPayload(),
    });
    this.queue.dispatch({
      type: 'CLEAR_STEERING_CHIPS',
    });
    this.internalDispatch = false;
  }

  async syncVideo() {
    // An empty list (the host's between a clear and its new list) has nothing
    // to look up, and the lookup refuses it
    if (this._videoList.length === 0) {
      if (this.rawItems?.length) this.clear();
      return true;
    }
    const room = this.room;
    const response = await getMusicQueueRenderer(
      this._videoList.map((it) => it.videoId),
    );
    if (!response || this.room !== room) return false;

    const items = response.queueDatas.map((it) => it.content);

    this.internalDispatch = true;
    this.queue?.dispatch({
      type: 'UPDATE_ITEMS',
      payload: {
        items: items,
        nextQueueItemId:
          this.queue.queue.store.store.getState().queue.nextQueueItemId,
        shouldAssignIds: true,
        currentIndex: -1,
      },
    });
    this.internalDispatch = false;
    setTimeout(() => {
      this.initQueue();
      this.syncQueueOwner();
    }, 0);

    return true;
  }

  syncQueueOwner() {
    const allQueue = document.querySelectorAll('#queue');

    allQueue.forEach((queue) => {
      const list = Array.from(
        queue?.querySelectorAll<HTMLElement>(
          '#contents > ytmusic-player-queue-item,#contents > ytmusic-playlist-panel-video-wrapper-renderer > #primary-renderer > ytmusic-player-queue-item',
        ) ?? [],
      );

      list.forEach((item, index: number | undefined) => {
        if (typeof index !== 'number') return;

        const id = this._videoList[index]?.ownerId;
        let data = this.getProfile(id);

        const profile =
          item.querySelector<HTMLImageElement>('.music-together-owner') ??
          document.createElement('img');
        profile.classList.add('music-together-owner');
        profile.dataset.id = id;
        profile.dataset.index = index.toString();

        const name =
          item.querySelector<HTMLElement>('.music-together-name') ??
          document.createElement('div');
        name.classList.add('music-together-name');
        name.textContent =
          data?.name ?? t('plugins.music-together.internal.unknown-user');

        if (!data?.name && !data?.handleId) {
          data = getDefaultProfile(data?.id ?? '');
        }

        if (data) {
          profile.dataset.thumbnail = data.thumbnail ?? '';
          profile.dataset.name = data.name ?? '';
          profile.dataset.handleId = data.handleId ?? '';
          profile.dataset.id = data.id ?? '';

          profile.src = data.thumbnail ?? '';
          profile.title = data.name ?? '';
          profile.alt = data.handleId ?? '';
        }

        if (!profile.isConnected) item.append(profile);
        if (!name.isConnected) item.append(name);
      });
    });
  }

  removeQueueOwner() {
    const allQueue = document.querySelectorAll('#queue');

    allQueue.forEach((queue) => {
      const list = Array.from(
        queue?.querySelectorAll<HTMLElement>('ytmusic-player-queue-item') ?? [],
      );

      list.forEach((item) => {
        const profile = item.querySelector<HTMLImageElement>(
          '.music-together-owner',
        );
        const name = item.querySelector<HTMLElement>('.music-together-name');
        profile?.remove();
        name?.remove();
      });
    });
  }

  /* private */
  private broadcast(event: ConnectionEventUnion) {
    this.listeners.forEach((listener) => listener(event));
  }
}

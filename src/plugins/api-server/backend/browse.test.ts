import { readFileSync } from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import {
  type Json,
  parseAlbum,
  parseArtist,
  parsePlaylist,
  parseQueue,
  parseSearch,
  seconds,
} from './browse';

// Answers of the site, shortened to a few items each
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, 'fixtures', `${name}.json`),
      'utf8',
    ),
  ) as Json;
const linkinPark = { id: 'UCxgN32UVVztKAQd2HkXzBtw', name: 'Linkin Park' };

test('lengths read as seconds', () => {
  expect(seconds('3:12')).toBe(192);
  expect(seconds('1:02:03')).toBe(3723);
  expect(seconds('3.2M plays')).toBeNull();
});

test('a search for songs gives songs with artists, album, length and a next page', () => {
  const { items, continuation } = parseSearch(fixture('search-songs'));
  expect(items[0]).toEqual({
    type: 'song',
    id: 'Nh4T_4DJX4M',
    title: 'Faint (Demo 2002)',
    subtitle:
      'Linkin Park • Meteora 20th Anniversary Edition • 3:12 • 3.2M plays',
    artists: [linkinPark],
    album: {
      id: 'MPREb_DOhy8PyMH41',
      name: 'Meteora 20th Anniversary Edition',
    },
    duration: 192,
    thumbnail: expect.stringMatching(/^https:/),
    playlistId: null,
    slot: null,
    available: true,
  });
  expect(continuation).toEqual(expect.any(String));

  const next = parseSearch(fixture('search-songs-next'));
  expect(next.items.length).toBeGreaterThan(0);
  expect(next.items.every((item) => item.type === 'song')).toBe(true);
  expect(next.continuation).toEqual(expect.any(String));
});

test('a search without a filter starts with the top result', () => {
  const { items } = parseSearch(fixture('search'));
  expect(items[0]).toMatchObject({
    type: 'album',
    id: 'MPREb_qMlbe7gLeuH',
    title: 'Meteora',
    artists: [linkinPark],
    playlistId: 'OLAK5uy_nE-SkwNA6lYF99wd-MHzJVqThnUIJGe3I',
  });
  expect(items.length).toBeGreaterThan(1);
});

test('videos name their channel, playlists their author', () => {
  expect(parseSearch(fixture('search-videos')).items[0]).toMatchObject({
    type: 'video',
    id: 'ZvXjl20nB6Q',
    artists: [
      { id: 'UCzoBFj25zw7eSpZ08yriIMA', name: 'Md. Riasat Azim Aditto' },
    ],
    duration: 238,
  });
  expect(parseSearch(fixture('search-playlists')).items[0]).toMatchObject({
    type: 'playlist',
    id: 'VLPLd9p7ZJWGPtmbjHzxJm7dGQKy-QV0Q4xJ',
    artists: [{ id: 'UCR_XOqa51vWP2ve8t5DEOiQ', name: 'Thanapat Haboonpat' }],
    playlistId: 'PLd9p7ZJWGPtmbjHzxJm7dGQKy-QV0Q4xJ',
  });
});

test("an album's songs get the album's artists and list", () => {
  const { album, tracks } = parseAlbum('MPREb_qMlbe7gLeuH', fixture('album'));
  expect(album).toMatchObject({
    title: 'Meteora',
    artists: [linkinPark],
    year: '2003',
    stats: '13 songs • 36 minutes',
    playlistId: 'OLAK5uy_nE-SkwNA6lYF99wd-MHzJVqThnUIJGe3I',
  });
  expect(tracks[0]).toMatchObject({
    type: 'song',
    id: 'U6R-twDkrcI',
    title: 'Foreword',
    artists: [linkinPark],
    album: { id: 'MPREb_qMlbe7gLeuH', name: 'Meteora' },
    duration: 14,
    playlistId: 'OLAK5uy_nE-SkwNA6lYF99wd-MHzJVqThnUIJGe3I',
    slot: '96E0CCD447DC4DDB',
  });
});

test("an artist's page has its sections, each with a link to all of it", () => {
  const { artist, sections } = parseArtist(linkinPark.id, fixture('artist'));
  expect(artist.name).toBe('Linkin Park');
  expect(artist.stats).not.toBe('');
  expect(sections[0]).toMatchObject({
    title: 'Top songs',
    more: 'VLOLAK5uy_k7mmOSpP63ccIRmgod4PkMPARvWuYw6dA',
  });
  expect(sections[0].items[0].type).toBe('song');
  const albums = sections.find((section) => section.title === 'Albums');
  expect(albums?.items[0]).toMatchObject({
    type: 'album',
    id: 'MPREb_d1UkStdzUrN',
    title: 'From Zero',
    playlistId: 'OLAK5uy_miCUHAHUPqc21dc-Vs7KTxbbqqzFCl68c',
  });
});

test('a playlist gives its songs with their places, then the next page', () => {
  const first = parsePlaylist(
    'VLOLAK5uy_k7mmOSpP63ccIRmgod4PkMPARvWuYw6dA',
    fixture('playlist'),
  );
  expect(first.playlist).toMatchObject({
    title: 'Top songs',
    stats: '150 songs • 9 hours, 5 minutes',
  });
  expect(first.tracks[0]).toMatchObject({
    type: 'song',
    id: 'BLZWkjBXfN8',
    title: 'In the End',
    artists: [linkinPark],
    album: { name: 'Hybrid Theory (Bonus Edition)' },
    duration: 217,
    slot: '842AEE93FC5E2636',
  });
  expect(first.continuation).toEqual(expect.any(String));

  const next = parsePlaylist(
    'VLOLAK5uy_k7mmOSpP63ccIRmgod4PkMPARvWuYw6dA',
    fixture('playlist-next'),
  );
  expect(next.playlist).toBeNull();
  expect(next.tracks.length).toBeGreaterThan(0);
  expect(next.tracks.every((track) => track.slot)).toBe(true);
});

test('the queue gives its songs and which one plays', () => {
  const { items, current } = parseQueue(fixture('queue'));
  expect(items[0]).toMatchObject({
    id: 'U6R-twDkrcI',
    title: 'Foreword',
    artists: [linkinPark],
    duration: 14,
    playlistId: 'OLAK5uy_nE-SkwNA6lYF99wd-MHzJVqThnUIJGe3I',
    slot: '96E0CCD447DC4DDB',
  });
  expect(current).toBe(2);
  expect(items[2].title).toBe('Somewhere I Belong');
});

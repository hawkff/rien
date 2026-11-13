import { test, expect } from '@playwright/test';

import { isBotCheck, retryBlocked } from './retry-blocked';

Object.assign(globalThis, { location: { href: 'https://music.example/' } });

const api =
  'https://music.example/\u0079\u006f\u0075\u0074\u0075\u0062\u0065i/v1';
const blocked = () =>
  new Response('<title>Sorry...</title>', {
    status: 403,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  });
const passes = () => new Response('{}', { status: 200 });

// A fetch that gives the answers in order and counts its calls
const answers = (...responses: (() => Response)[]) => {
  const calls: string[] = [];
  const fetch = (input: RequestInfo | URL) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(responses[calls.length - 1]());
  };
  return { calls, fetch };
};
const waits: number[] = [];
const wait = (ms: number) => {
  waits.push(ms);
  return Promise.resolve();
};

test('a refused API request is sent again', async () => {
  waits.length = 0;
  const { calls, fetch } = answers(blocked, blocked, passes);
  const response = await retryBlocked(fetch, wait)(`${api}/browse`, {
    method: 'POST',
    body: '{}',
  });
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(3);
  expect(waits).toEqual([300, 600]);
});

test('the eighth refusal reaches the page', async () => {
  waits.length = 0;
  const { calls, fetch } = answers(
    ...Array<() => Response>(8).fill(blocked),
    passes,
  );
  const response = await retryBlocked(fetch, wait)(`${api}/next`, {
    method: 'POST',
    body: '{}',
  });
  expect(response.status).toBe(403);
  expect(calls).toHaveLength(8);
  expect(waits).toEqual([300, 600, 900, 1200, 1500, 1800, 2100]);
});

test('other answers and other requests go through once', async () => {
  const json = () =>
    new Response('{"error":{}}', {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  const player = answers(json, passes);
  const answer = await retryBlocked(player.fetch, wait)(`${api}/player`);
  expect(answer.status).toBe(403);
  expect(player.calls).toHaveLength(1);

  const other = answers(blocked, passes);
  const lyrics = await retryBlocked(
    other.fetch,
    wait,
  )('https://lrclib.example/api');
  expect(lyrics.status).toBe(403);
  expect(other.calls).toEqual(['https://lrclib.example/api']);
});

test('an earlier request stops trying once a newer one of its kind went out', async () => {
  // The first request waits after its refusal until the second one is done.
  let release = () => {};
  const held = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const { calls, fetch } = answers(blocked, passes, passes);
  const retrying = retryBlocked(fetch, held);
  const first = retrying(`${api}/browse`, { method: 'POST', body: '1' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await retrying(`${api}/browse`, { method: 'POST', body: '2' });
  release();
  expect(second.status).toBe(200);
  expect((await first).status).toBe(403);
  expect(calls).toHaveLength(2);
});

// YouTube's bot check, as the player answers it (trimmed)
const botCheck = () =>
  new Response(
    JSON.stringify({
      playabilityStatus: {
        status: 'LOGIN_REQUIRED',
        reason: 'Melde dich an, um zu bestätigen, dass du kein Bot bist',
        errorScreen: {
          playerErrorMessageRenderer: {
            subreason: {
              runs: [
                {
                  text: 'Weitere Informationen',
                  navigationEndpoint: {
                    urlEndpoint: {
                      url: 'https://support.google.com/youtube/answer/3037019#zippy=%2Ccheck-that-youre-signed-into-youtube',
                    },
                  },
                },
              ],
            },
          },
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const plays = () =>
  new Response('{"playabilityStatus":{"status":"OK"}}', { status: 200 });

test('the bot check is told from an age check in any language', () => {
  expect(
    isBotCheck({
      playabilityStatus: {
        status: 'LOGIN_REQUIRED',
        reason: 'Sign in to confirm your age',
        errorScreen: {
          url: 'https://support.google.com/youtube/answer/2802167',
        },
      },
    }),
  ).toBe(false);
  expect(
    isBotCheck({
      playabilityStatus: {
        status: 'LOGIN_REQUIRED',
        reason: 'Sign in to confirm you’re not a bot',
      },
    }),
  ).toBe(true);
  expect(isBotCheck({ playabilityStatus: { status: 'OK' } })).toBe(false);
  expect(isBotCheck(null)).toBe(false);
});

test('a bot check moves the player request to the next exit until one plays', async () => {
  const { calls, fetch } = answers(botCheck, botCheck, plays);
  const moves: string[] = [];
  const nextExit = (reason: string) => {
    moves.push(reason);
    return Promise.resolve(true);
  };
  const response = await retryBlocked(
    fetch,
    wait,
    nextExit,
  )(`${api}/player`, {
    method: 'POST',
    body: '{}',
  });
  expect(await response.json()).toEqual({
    playabilityStatus: { status: 'OK' },
  });
  expect(calls).toHaveLength(3);
  expect(moves).toEqual(['bot-check', 'bot-check']);
});

test('without an exit to move to, the bot check reaches the page', async () => {
  const { calls, fetch } = answers(botCheck, plays);
  const response = await retryBlocked(fetch, wait, () =>
    Promise.resolve(false),
  )(`${api}/player`, { method: 'POST', body: '{}' });
  expect(isBotCheck(await response.json())).toBe(true);
  expect(calls).toHaveLength(1);
});

test('after a bot check, refusals on the next exit move on again', async () => {
  const moves: string[] = [];
  const nextExit = (reason: string) => {
    moves.push(reason);
    return Promise.resolve(true);
  };
  const { calls, fetch } = answers(botCheck, blocked, blocked, plays);
  const response = await retryBlocked(
    fetch,
    wait,
    nextExit,
  )(`${api}/player`, {
    method: 'POST',
    body: '{}',
  });
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(4);
  expect(moves).toEqual(['bot-check', 'refused']);
});

test('a player request refused twice moves once; other requests never move', async () => {
  const moves: string[] = [];
  const nextExit = (reason: string) => {
    moves.push(reason);
    return Promise.resolve(true);
  };
  const player = answers(blocked, blocked, blocked, plays);
  await retryBlocked(
    player.fetch,
    wait,
    nextExit,
  )(`${api}/player`, {
    method: 'POST',
    body: '{}',
  });
  expect(player.calls).toHaveLength(4);
  expect(moves).toEqual(['refused']);

  moves.length = 0;
  const next = answers(blocked, blocked, blocked, botCheck);
  await retryBlocked(
    next.fetch,
    wait,
    nextExit,
  )(`${api}/next`, {
    method: 'POST',
    body: '{}',
  });
  expect(moves).toEqual([]);
});

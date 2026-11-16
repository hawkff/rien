import { test, expect } from '@playwright/test';

import { apiServerRead, isBotCheck, retryBlocked } from './retry-blocked';

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

test('a read the API server asked for keeps trying when the page sends one of its kind, and its mark stays in the app', async () => {
  let release = () => {};
  const held = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const { calls, fetch } = answers(blocked, passes, passes);
  const retrying = retryBlocked(fetch, held);
  const asked = retrying(`${api}/browse?${apiServerRead}`, {
    method: 'POST',
    body: '1',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const page = await retrying(`${api}/browse`, { method: 'POST', body: '2' });
  release();
  expect(page.status).toBe(200);
  expect((await asked).status).toBe(200);
  expect(calls).toEqual([`${api}/browse`, `${api}/browse`, `${api}/browse`]);
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

// A fetch whose answers come after the given delays, in order of the calls,
// and that stops a call when its signal says so
const timed = (...plans: [number, () => Response | Error][]) => {
  const signals: (AbortSignal | undefined)[] = [];
  const fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const [ms, answer] = plans[signals.length];
      const { signal } = init ?? {};
      signals.push(signal ?? undefined);
      const timer = setTimeout(() => {
        const result = answer();
        if (result instanceof Error) reject(result);
        else resolve(result);
      }, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      });
    });
  return { signals, fetch };
};

test('a read-only request without an answer in time gets a second copy, and the first good answer wins', async () => {
  const { signals, fetch } = timed([2000, blocked], [10, passes]);
  const started = Date.now();
  const response = await retryBlocked(
    fetch,
    wait,
    undefined,
    50,
  )(`${api}/player`, { method: 'POST', body: '{}' });
  expect(response.status).toBe(200);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(signals).toHaveLength(2);
  // The slow copy stops; the winner's body stays readable
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  expect(await response.text()).toBe('{}');
});

test('an older request gets no second copy once a newer one of its kind went out', async () => {
  // The older request's first copy is refused late; the newer one answers
  const { signals, fetch } = timed([200, blocked], [5, passes], [5, passes]);
  const retrying = retryBlocked(fetch, wait, undefined, 50);
  const older = retrying(`${api}/browse`, { method: 'POST', body: '1' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const newer = await retrying(`${api}/browse`, { method: 'POST', body: '2' });
  expect(newer.status).toBe(200);
  expect((await older).status).toBe(403);
  expect(signals).toHaveLength(2);
});

test('two refused copies count as one refusal, and the request tries again', async () => {
  waits.length = 0;
  const { signals, fetch } = timed([80, blocked], [10, blocked], [5, passes]);
  const response = await retryBlocked(
    fetch,
    wait,
    undefined,
    20,
  )(`${api}/browse`, { method: 'POST', body: '{}' });
  expect(response.status).toBe(200);
  expect(signals).toHaveLength(3);
  expect(waits).toEqual([300]);
});

test('a read-only request tries again after a network error; an action never repeats', async () => {
  waits.length = 0;
  const lost = () => new TypeError('Failed to fetch');
  const reads = timed([5, lost], [5, passes]);
  const response = await retryBlocked(
    reads.fetch,
    wait,
    undefined,
    1000,
  )(`${api}/next`, { method: 'POST', body: '{}' });
  expect(response.status).toBe(200);
  expect(waits).toEqual([1000]);

  // A like: no second copy however slow, and its network error reaches the page
  const like = timed([100, lost], [5, passes]);
  await expect(
    retryBlocked(
      like.fetch,
      wait,
      undefined,
      10,
    )(`${api}/like/like`, {
      method: 'POST',
      body: '{}',
    }),
  ).rejects.toThrow('Failed to fetch');
  expect(like.signals).toHaveLength(1);
});

test("the page's own abort stops every copy and isn't tried again", async () => {
  waits.length = 0;
  const { signals, fetch } = timed([500, passes], [500, passes]);
  const controller = new AbortController();
  const asked = retryBlocked(
    fetch,
    wait,
    undefined,
    20,
  )(`${api}/browse`, {
    method: 'POST',
    body: '{}',
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.abort();
  await expect(asked).rejects.toThrow();
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
  expect(waits).toEqual([]);
});

test('after a network error, an older request stops once a newer one of its kind went out', async () => {
  let release = () => {};
  const held = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const lost = () => new TypeError('Failed to fetch');
  const { signals, fetch } = timed([5, lost], [5, passes], [5, passes]);
  const retrying = retryBlocked(fetch, held, undefined, 1000);
  const first = retrying(`${api}/browse`, { method: 'POST', body: '1' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await retrying(`${api}/browse`, { method: 'POST', body: '2' });
  release();
  expect(second.status).toBe(200);
  await expect(first).rejects.toThrow('Failed to fetch');
  // The older request sent nothing after the newer one
  expect(signals).toHaveLength(2);
});

test("the page's abort ends the wait after a network error at once", async () => {
  const forever = () => new Promise<void>(() => {});
  const lost = () => new TypeError('Failed to fetch');
  const { signals, fetch } = timed([5, lost], [5, passes]);
  const controller = new AbortController();
  const asked = retryBlocked(
    fetch,
    forever,
    undefined,
    1000,
  )(`${api}/next`, {
    method: 'POST',
    body: '{}',
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const started = Date.now();
  controller.abort();
  await expect(asked).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(500);
  expect(signals).toHaveLength(1);
});

import { test, expect } from '@playwright/test';

import { retryBlocked } from './retry-blocked';

Object.assign(globalThis, { location: { href: 'https://music.example/' } });

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
  const response = await retryBlocked(fetch, wait)(
    'https://music.example/\u0079\u006f\u0075\u0074\u0075\u0062\u0065i/v1/browse',
    { method: 'POST', body: '{}' },
  );
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(3);
  expect(waits).toEqual([1000, 2000]);
});

test('the third refusal reaches the page', async () => {
  const { calls, fetch } = answers(blocked, blocked, blocked, passes);
  const response = await retryBlocked(fetch, wait)(
    'https://music.example/\u0079\u006f\u0075\u0074\u0075\u0062\u0065i/v1/next',
    { method: 'POST', body: '{}' },
  );
  expect(response.status).toBe(403);
  expect(calls).toHaveLength(3);
});

test('other answers and other requests go through once', async () => {
  const json = () =>
    new Response('{"error":{}}', {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  const api = answers(json, passes);
  expect(
    (
      await retryBlocked(
        api.fetch,
        wait,
      )(
        'https://music.example/\u0079\u006f\u0075\u0074\u0075\u0062\u0065i/v1/player',
      )
    ).status,
  ).toBe(403);
  expect(api.calls).toHaveLength(1);

  const other = answers(blocked, passes);
  expect(
    (await retryBlocked(other.fetch, wait)('https://lrclib.example/api'))
      .status,
  ).toBe(403);
  expect(other.calls).toEqual(['https://lrclib.example/api']);
});

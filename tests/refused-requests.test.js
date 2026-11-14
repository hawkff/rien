import path from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';

const appPath = path.resolve(import.meta.dirname, '..');
const api = '/\u0079\u006f\u0075\u0074\u0075\u0062\u0065i/v1/';

// Answers the test gives to its own queue requests, in order
const answers = {
  refused: {
    status: 403,
    contentType: 'text/html',
    body: '<title>Sorry...</title>',
  },
  error: { status: 400, contentType: 'application/json', body: '{"error":1}' },
  passes: { status: 200, contentType: 'application/json', body: '{"ok":1}' },
};

test('A refused read is sent again, other answers once', async () => {
  test.setTimeout(180_000);

  const userData = test.info().outputPath('profile');
  const app = await electron.launch({
    cwd: appPath,
    args: [
      appPath,
      `--user-data-dir=${userData}`,
      '--no-sandbox',
      '--disable-gpu',
      '--whitelisted-ips=',
      '--disable-dev-shm-usage',
    ],
  });
  try {
    // Any of the app's pages has the retry, the consent page among them, and
    // the test's requests go to the page's own address.
    const window = await app.firstWindow();
    await window.waitForURL(/^https:\/\//, { timeout: 60_000 });
    await window.waitForLoadState('domcontentloaded');

    // Only the requests that the test makes carry its mark
    let queue = [];
    let calls = 0;
    await window.route(
      (url) => url.pathname.startsWith(api) && url.searchParams.has('test'),
      async (route) => {
        calls++;
        const answer = queue.shift() ?? 'passes';
        if (answer === 'lost') return route.abort('connectionfailed');
        if (answer === 'slow') await new Promise((r) => setTimeout(r, 3000));
        const { status, contentType, body } = answers[answer] ?? answers.passes;
        await route.fulfill({ status, contentType, body }).catch(() => {});
      },
    );

    // Sends an API request the way the page does, the queue request unless
    // named, and reports what it saw
    const request = async (planned, abortAfter, endpoint = 'next') => {
      queue = planned;
      calls = 0;
      const result = await window.evaluate(
        ([url, abortAfter]) =>
          new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            const events = [];
            for (const type of ['load', 'error', 'abort']) {
              xhr.addEventListener(type, () => events.push(type));
            }
            xhr.addEventListener('loadend', () =>
              resolve({
                status: xhr.status,
                body: xhr.responseText,
                type: xhr.getResponseHeader('content-type'),
                events,
              }),
            );
            xhr.open('POST', url);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send('{}');
            if (abortAfter) setTimeout(() => xhr.abort(), abortAfter);
          }),
        [`${api}${endpoint}?test=1`, abortAfter],
      );
      return { ...result, calls };
    };

    expect(await request(['refused', 'passes'])).toMatchObject({
      status: 200,
      body: '{"ok":1}',
      events: ['load'],
      calls: 2,
    });
    expect(await request(['error'])).toMatchObject({
      status: 400,
      body: '{"error":1}',
      type: 'application/json',
      calls: 1,
    });
    // Three refusals in a row, as seen behind a VPN exit, still end in the
    // answer; the eighth refusal reaches the page.
    expect(
      await request(['refused', 'refused', 'refused', 'passes']),
    ).toMatchObject({ status: 200, calls: 4 });
    expect(
      await request([...Array(8).fill('refused'), 'passes']),
    ).toMatchObject({ status: 403, calls: 8 });
    // The queue request only reads: a lost connection tries again, and the
    // third one in a row reaches the page
    expect(await request(['lost', 'passes'])).toMatchObject({
      status: 200,
      events: ['load'],
      calls: 2,
    });
    expect(await request(['lost', 'lost', 'lost', 'passes'])).toMatchObject({
      status: 0,
      events: ['error'],
      calls: 3,
    });
    // An answer that takes 3 s gets a second copy after 1.5 s, which wins
    const started = Date.now();
    expect(await request(['slow', 'passes'])).toMatchObject({
      status: 200,
      body: '{"ok":1}',
      events: ['load'],
      calls: 2,
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await request(['slow'], 500)).toMatchObject({
      status: 0,
      events: ['abort'],
      calls: 1,
    });
    // The page's other reads, the API server's among them, are sent again
    // too; a request that changes something goes once
    for (const endpoint of ['browse', 'search']) {
      expect(
        await request(['refused', 'passes'], undefined, endpoint),
      ).toMatchObject({ status: 200, body: '{"ok":1}', calls: 2 });
    }
    expect(
      await request(['refused', 'passes'], undefined, 'like/like'),
    ).toMatchObject({ status: 403, calls: 1 });
  } finally {
    await app.close();
  }
});

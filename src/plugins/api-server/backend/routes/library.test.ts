import { OpenAPIHono } from '@hono/zod-openapi';
import { test, expect } from '@playwright/test';

import { register } from './library';

// A page that answers the routes' calls: the sign-in check, and each request
// to the site with `answer`. It records the requests it gets.
const setUp = (signedIn: boolean | null, answer: unknown) => {
  const sent: { endpoint: string; body: unknown }[] = [];
  const executeJavaScript = (script: string) => {
    if (script.includes('LOGGED_IN')) return Promise.resolve(signedIn);
    const [, endpoint, body] =
      /fetch\(("[^"]*"), (.*)\) \?\? null$/.exec(script) ?? [];
    sent.push({
      endpoint: JSON.parse(endpoint) as string,
      body: JSON.parse(body),
    });
    return Promise.resolve(answer);
  };
  const app = new OpenAPIHono();
  register(app, { window: { webContents: { executeJavaScript } } } as never);
  const call = (method: string, path: string, json?: object) =>
    app.request(`/api/v1${path}`, {
      method,
      headers: json ? { 'content-type': 'application/json' } : {},
      body: json ? JSON.stringify(json) : undefined,
    });
  return { sent, call };
};

test('changes stop while Rien is signed out, before reaching the site', async () => {
  const { sent, call } = setUp(false, {});
  const response = await call('POST', '/library/feedback', { tokens: ['a'] });
  expect(response.status).toBe(409);
  expect(sent).toEqual([]);
});

test('a playlist is created private unless asked otherwise', async () => {
  const { sent, call } = setUp(true, { playlistId: 'PLnew' });
  const response = await call('POST', '/playlists', { title: 'Test' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: 'PLnew' });
  expect(sent).toEqual([
    {
      endpoint: '/playlist/create',
      body: { title: 'Test', description: '', privacyStatus: 'PRIVATE' },
    },
  ]);
});

test('a song twice in one add needs duplicates, and is not sent without', async () => {
  const { sent, call } = setUp(true, { status: 'STATUS_SUCCEEDED' });
  const twice = { videoIds: ['aaaaaaaaaaa', 'aaaaaaaaaaa'] };
  expect((await call('POST', '/playlists/PLx/add', twice)).status).toBe(400);
  expect(sent).toEqual([]);
  const allowed = await call('POST', '/playlists/VLPLx/add', {
    ...twice,
    duplicates: true,
  });
  expect(allowed.status).toBe(200);
  expect(sent[0].body).toMatchObject({ playlistId: 'PLx' });
});

test('a refused edit is 502, and no answer says the change may have happened', async () => {
  const refused = setUp(true, { status: 'STATUS_FAILED' });
  const remove = {
    items: [{ videoId: 'aaaaaaaaaaa', slot: 'S1' }],
  };
  expect(
    (await refused.call('POST', '/playlists/PLx/remove', remove)).status,
  ).toBe(502);
  expect((await refused.call('DELETE', '/playlists/PLx')).status).toBe(502);

  const silent = setUp(true, null);
  const response = await silent.call('POST', '/library/rate', {
    videoId: 'aaaaaaaaaaa',
    status: 'LIKE',
  });
  expect(response.status).toBe(503);
  expect(((await response.json()) as { error: string }).error).toMatch(
    /may have gone through/,
  );
});

test('a sign-in state the page does not give lets the change go on', async () => {
  const { sent, call } = setUp(null, {});
  expect(
    (
      await call('POST', '/library/rate', {
        playlistId: 'VLOLAK5uy_x',
        status: 'INDIFFERENT',
      })
    ).status,
  ).toBe(204);
  expect(sent).toEqual([
    {
      endpoint: '/like/removelike',
      body: { target: { playlistId: 'OLAK5uy_x' } },
    },
  ]);
});

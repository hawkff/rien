import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';
import { sign } from 'hono/jwt';

const appPath = path.resolve(import.meta.dirname, '..');

// Older versions saved the time of a start as the secret: eight characters in
// base 36.
const oldSecret = 'mhv4k2ab';

// shortcut: another process can take the port before the app binds it; if
// that ever happens, let the app report the port it got.
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

test('A token signed with a secret from an older version is refused', async () => {
  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  const songStatus = async (token) => {
    const response = await fetch(`${api}/api/v1/song`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.status;
  };

  // A profile of its own, so the test neither reads nor changes the user's
  const userData = test.info().outputPath('profile');
  mkdirSync(userData, { recursive: true });
  writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      plugins: {
        'api-server': {
          enabled: true,
          hostname: '127.0.0.1',
          port,
          secret: oldSecret,
          // Paired already, so the server issues a token without asking
          authorizedClients: ['test'],
        },
      },
    }),
  );

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
    // The server starts with the app. Ask until it answers.
    let accessToken;
    await expect(async () => {
      const response = await fetch(`${api}/auth/test`, { method: 'POST' });
      ({ accessToken } = await response.json());
    }).toPass({ timeout: 30_000 });

    const oldToken = await sign(
      { id: 'test', iat: Math.floor(Date.now() / 1000) },
      oldSecret,
    );
    expect(await songStatus(oldToken)).toBe(401);
    // 204 while no song plays
    expect([200, 204]).toContain(await songStatus(accessToken));
  } finally {
    await app.close();
  }
});

test('A search through the API gives plain items', async () => {
  test.setTimeout(120_000);
  const port = await freePort();
  const api = `http://127.0.0.1:${port}/api/v1`;
  const userData = test.info().outputPath('profile');
  mkdirSync(userData, { recursive: true });
  // No hostname: the server listens on this computer only by default
  writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      plugins: {
        'api-server': { enabled: true, port, authStrategy: 'NONE' },
      },
    }),
  );

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
    // The page answers searches once it has loaded
    await expect(async () => {
      const response = await fetch(
        `${api}/browse/search?q=Linkin%20Park%20Numb&filter=songs`,
      );
      expect(response.status).toBe(200);
      const { items } = await response.json();
      expect(items[0]).toMatchObject({
        type: 'song',
        id: expect.stringMatching(/^[\w-]{11}$/),
        artists: [expect.objectContaining({ name: expect.any(String) })],
      });
    }).toPass({ timeout: 90_000 });

    const playNow = await fetch(`${api}/play-now`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(playNow.status).toBe(400);
  } finally {
    await app.close();
  }
});

test('A token stays good after the app restarts', async () => {
  test.setTimeout(120_000);
  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  const userData = test.info().outputPath('profile');
  mkdirSync(userData, { recursive: true });
  // No secret in the settings: the app makes one
  writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      plugins: {
        'api-server': { enabled: true, port, authorizedClients: ['test'] },
      },
    }),
  );
  const start = () =>
    electron.launch({
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
  const songStatus = async (token) =>
    (
      await fetch(`${api}/api/v1/song`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status;

  let app = await start();
  let accessToken;
  try {
    await expect(async () => {
      const response = await fetch(`${api}/auth/test`, { method: 'POST' });
      ({ accessToken } = await response.json());
    }).toPass({ timeout: 30_000 });
  } finally {
    await app.close();
  }

  app = await start();
  try {
    await expect(async () => {
      expect([200, 204]).toContain(await songStatus(accessToken));
    }).toPass({ timeout: 30_000 });
  } finally {
    await app.close();
  }
});

// Calls into the music page, with the page's own session, for the API's
// routes. The inputs go in as JSON literals.
import { createHash } from 'node:crypto';

import type { Json } from './browse';
import type { BrowserWindow } from 'electron';

// A promise's value, or `fallback` when it takes longer than `ms`
export const within = async <T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** The site's API answer to a request the page sends, or null when it fails or takes over `ms` */
export const askPage = async (
  window: BrowserWindow,
  endpoint: string,
  body: object,
  ms = 20_000,
) => {
  try {
    const answer: unknown = await within(
      window.webContents.executeJavaScript(
        `document.querySelector('ytmusic-app')?.networkManager?.fetch(${JSON.stringify(endpoint)}, ${JSON.stringify(body)}) ?? null`,
      ),
      ms,
      null,
    );
    return (answer ?? null) as Json | null;
  } catch (error) {
    console.error('The page could not answer', endpoint, error);
    return null;
  }
};

/** A key that tells the page's accounts apart and can't be turned back into the account's ID: the first 16 hex digits of the ID's SHA-256 */
export const accountKey = (id: string) =>
  createHash('sha256').update(id).digest('hex').slice(0, 16);

/** The key of the account the page is signed in to; null when signed out, or when the page doesn't say within 5 s */
export const pageAccount = async (window: BrowserWindow) => {
  const id = await within(
    window.webContents
      .executeJavaScript(
        'window.ytcfg?.get?.("LOGGED_IN") ? (window.ytcfg.get("DATASYNC_ID") ?? null) : null',
      )
      .catch(() => null) as Promise<unknown>,
    5_000,
    null,
  );
  return typeof id === 'string' && id ? accountKey(id) : null;
};

/** Whether the page is signed in; null when it doesn't say within 5 s */
export const pageSignedIn = (window: BrowserWindow) =>
  within(
    window.webContents
      .executeJavaScript('window.ytcfg?.get?.("LOGGED_IN") ?? null')
      .catch(() => null) as Promise<boolean | null>,
    5_000,
    null,
  );

// Calls into the music page, with the page's own session, for the API's
// routes. The inputs go in as JSON literals.
import type { Json } from './browse';
import type { BrowserWindow } from 'electron';

// A promise's value, or `fallback` when it takes longer than `ms`
const within = async <T>(promise: Promise<T>, ms: number, fallback: T) => {
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

/** The site's API answer to a request the page sends, or null when it fails or takes over 20 s */
export const askPage = async (
  window: BrowserWindow,
  endpoint: string,
  body: object,
) => {
  try {
    const answer: unknown = await within(
      window.webContents.executeJavaScript(
        `document.querySelector('ytmusic-app')?.networkManager?.fetch(${JSON.stringify(endpoint)}, ${JSON.stringify(body)}) ?? null`,
      ),
      20_000,
      null,
    );
    return (answer ?? null) as Json | null;
  } catch (error) {
    console.error('The page could not answer', endpoint, error);
    return null;
  }
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

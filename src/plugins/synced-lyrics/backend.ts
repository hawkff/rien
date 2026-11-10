import { net } from 'electron';

import { loadNative } from '@/native';
import { createBackend } from '@/utils';

const handlers = {
  // Note: This will only be used for Forbidden headers, e.g. User-Agent, Authority, Cookie, etc.
  // See: https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header
  async fetch(
    url: string,
    init: RequestInit,
  ): Promise<[number, string, Record<string, string>]> {
    const res = await net.fetch(url, init);
    return [
      res.status,
      await res.text(),
      Object.fromEntries(res.headers.entries()),
    ];
  },
};

export const backend = createBackend({
  start(ctx) {
    ctx.ipc.handle('synced-lyrics:fetch', (url: string, init: RequestInit) =>
      handlers.fetch(url, init),
    );
    ctx.ipc.handle(
      'synced-lyrics:detect-language',
      (text: string) => loadNative()?.detectLanguage(text) ?? null,
    );
    ctx.ipc.handle('synced-lyrics:romanize-japanese', (text: string) => {
      try {
        return loadNative()?.romanizeJapanese(text) ?? text;
      } catch (error: unknown) {
        console.error('Could not romanize Japanese:', error);
        return text;
      }
    });
  },
  stop(ctx) {
    ctx.ipc.removeHandler('synced-lyrics:fetch');
    ctx.ipc.removeHandler('synced-lyrics:detect-language');
    ctx.ipc.removeHandler('synced-lyrics:romanize-japanese');
  },
});

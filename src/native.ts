import { createRequire } from 'node:module';
import { join } from 'node:path';

import { app } from 'electron';

interface PearNative {
  detectLanguage(text: string): string | null;
  romanizeJapanese(text: string): string;
}

// electron-vite adds a `require` of its own to chunks that call require(), so
// this one has another name.
const requireNative = createRequire(import.meta.url);
let pearNative: PearNative | null | undefined;

// `bun run build:native` builds the module into dist/native/<arch>. A packaged
// app keeps it outside the asar archive. Returns null when the module is
// missing, so callers can fall back.
export const loadNative = () => {
  if (pearNative === undefined) {
    try {
      pearNative = requireNative(
        join(
          app.getAppPath(),
          'dist',
          'native',
          process.arch,
          'pear-native.node',
        ),
      ) as PearNative;
    } catch (error: unknown) {
      console.error('Could not load the native module:', error);
      pearNative = null;
    }
  }
  return pearNative;
};

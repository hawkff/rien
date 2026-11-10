import { test, expect } from '@playwright/test';

import { collectChunks, type Manifest } from './renderer-scripts';

// The shape of the manifest Vite writes for the page script
const manifest: Manifest = {
  'index.html': {
    file: 'app.cjs',
    isEntry: true,
    imports: ['_runtime.cjs'],
    dynamicImports: [
      'plugins/lyrics/index.ts',
      'plugins/clock.ts',
      'style.css',
    ],
  },
  '_runtime.cjs': { file: 'runtime.cjs' },
  '_shared.cjs': { file: 'shared.cjs', imports: ['_runtime.cjs'] },
  '_clock-only.cjs': { file: 'clock-only.cjs' },
  'plugins/lyrics/index.ts': {
    file: 'lyrics.cjs',
    imports: ['_shared.cjs'],
    dynamicImports: ['../node_modules/hangul/index.js'],
  },
  '../node_modules/hangul/index.js': {
    file: 'hangul.cjs',
    imports: ['_runtime.cjs'],
  },
  'plugins/clock.ts': {
    file: 'clock.cjs',
    imports: ['_shared.cjs', '_clock-only.cjs'],
  },
  'style.css': { file: 'app.css' },
};

test('leaves the chunks of disabled plugins out', () => {
  expect(
    collectChunks(manifest, 'index.html', new Set(['lyrics'])).sort(),
  ).toStrictEqual([
    'app.cjs',
    'hangul.cjs',
    'lyrics.cjs',
    'runtime.cjs',
    'shared.cjs',
  ]);
});

test('brings in only the missing chunks of a plugin enabled later', () => {
  const loaded = collectChunks(manifest, 'index.html', new Set(['lyrics']));
  expect(
    collectChunks(
      manifest,
      'plugins/clock.ts',
      new Set(['clock']),
      new Set(loaded),
    ).sort(),
  ).toStrictEqual(['clock-only.cjs', 'clock.cjs']);
});

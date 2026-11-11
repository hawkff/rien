import { readdirSync } from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { pluginSections } from './menu-sections';

// The plugins the build finds: folders with an index file, and single files.
const plugins = readdirSync(path.join(import.meta.dirname, 'plugins'), {
  withFileTypes: true,
})
  .filter((entry) => entry.name !== 'utils')
  .map((entry) =>
    entry.isDirectory() ? entry.name : entry.name.replace(/\.[jt]sx?$/, ''),
  );

test('every plugin has one section in the plugin menu', () => {
  const listed = Object.values(pluginSections).flat();
  expect([...listed].sort()).toEqual([...plugins].sort());
});

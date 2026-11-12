import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { placeCommand } from './place-command';

test('the command links to the app, or is a copy for an AppImage', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ytmpc-command-'));
  const binary = path.join(root, 'app', 'ytmpc');
  const target = path.join(root, 'home', '.local', 'bin', 'ytmpc');
  mkdirSync(path.dirname(binary), { recursive: true });
  writeFileSync(binary, '#!/bin/sh\n');

  // A dangling link from an older install gives way
  mkdirSync(path.dirname(target), { recursive: true });
  symlinkSync(path.join(root, 'gone'), target);
  placeCommand(binary, target, false);
  expect(lstatSync(target).isSymbolicLink()).toBe(true);
  expect(readlinkSync(target)).toBe(binary);

  placeCommand(binary, target, true);
  expect(lstatSync(target).isSymbolicLink()).toBe(false);
  expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\n');
  if (process.platform !== 'win32') {
    expect(statSync(target).mode & 0o777).toBe(0o755);
  }
  expect(existsSync(binary)).toBe(true);
  rmSync(root, { recursive: true });
});

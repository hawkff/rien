import { test, expect } from '@playwright/test';

import {
  linkHost,
  readViewerMessage,
  sameSecret,
  viewSize,
} from './remote-view';

test('a secret matches only itself, and an empty one nothing', () => {
  expect(sameSecret('abc', 'abc')).toBe(true);
  expect(sameSecret('abd', 'abc')).toBe(false);
  expect(sameSecret('ab', 'abc')).toBe(false);
  // The same number of characters, but not of bytes
  expect(sameSecret('é', 'ab')).toBe(false);
  expect(sameSecret('', '')).toBe(false);
  expect(sameSecret(undefined, 'abc')).toBe(false);
  expect(sameSecret(['abc'], 'abc')).toBe(false);
});

test('links name this computer for a server on every address', () => {
  expect(linkHost('0.0.0.0', 26538)).toBe('127.0.0.1:26538');
  expect(linkHost('::', 26538)).toBe('127.0.0.1:26538');
  expect(linkHost('127.0.0.1', 1)).toBe('127.0.0.1:1');
  expect(linkHost('192.168.1.5', 26538)).toBe('192.168.1.5:26538');
  expect(linkHost('::1', 26538)).toBe('[::1]:26538');
});

test('the window takes a viewer page size within reason', () => {
  expect(viewSize(1280.4, 799.6)).toEqual([1280, 800]);
  expect(viewSize(100, 100)).toEqual([480, 360]);
  expect(viewSize(10_000, 10_000)).toEqual([2560, 1600]);
});

test('the viewer page sends known messages only', () => {
  expect(
    readViewerMessage(
      '{"type":"hello","key":"k","width":1280,"height":800,"extra":1}',
    ),
  ).toEqual({ type: 'hello', key: 'k', width: 1280, height: 800 });
  const click = {
    type: 'mouse',
    event: 'mousePressed',
    x: 10.5,
    y: 20,
    button: 'left',
    clickCount: 1,
    deltaX: 0,
    deltaY: 0,
    modifiers: 0,
  };
  expect(readViewerMessage(JSON.stringify(click))).toEqual(click);
  const key = {
    type: 'key',
    event: 'keyDown',
    key: 'a',
    code: 'KeyA',
    text: 'a',
    keyCode: 65,
    modifiers: 8,
  };
  expect(readViewerMessage(JSON.stringify(key))).toEqual(key);
  for (const text of [
    '',
    'not json',
    'null',
    '{"type":"exec","command":"rm"}',
    JSON.stringify({ ...click, event: 'mouseFly' }),
    JSON.stringify({ ...click, x: 'left' }),
    JSON.stringify({ ...key, modifiers: 16 }),
    JSON.stringify({ type: 'text', text: 'x'.repeat(10_001) }),
  ]) {
    expect(readViewerMessage(text)).toBeUndefined();
  }
});

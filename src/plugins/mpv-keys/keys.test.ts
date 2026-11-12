import { test, expect } from '@playwright/test';

import { commandFor, defaultKeys, keyName, parseKeys } from './keys';

const element = (
  tagName: string,
  attributes: Record<string, string> = {},
  isContentEditable = false,
) => ({
  tagName,
  isContentEditable,
  getAttribute: (name: string) => attributes[name] ?? null,
});
const body = element('BODY');
const page = [body, element('HTML'), {}, {}];

const press = (
  key: string,
  path: unknown[] = page,
  modifiers: Partial<
    Record<
      'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing',
      boolean
    >
  > = {},
) => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  ...modifiers,
  composedPath: () => path,
});

const { bindings } = parseKeys(defaultKeys);
const command = (...args: Parameters<typeof press>) =>
  commandFor(press(...args), bindings);

test('the default keys run mpv commands', () => {
  expect(parseKeys(defaultKeys).skipped).toEqual([]);
  expect(command(' ')).toEqual({ name: 'play-pause' });
  expect(command('p')).toEqual({ name: 'play-pause' });
  expect(command('ArrowLeft')).toEqual({ name: 'seek', amount: -5 });
  expect(command('ArrowUp')).toEqual({ name: 'seek', amount: 60 });
  expect(command('ArrowRight', page, { shiftKey: true })).toEqual({
    name: 'seek',
    amount: 1,
  });
  expect(command('>', page, { shiftKey: true })).toEqual({ name: 'next' });
  expect(command('Enter')).toEqual({ name: 'next' });
  expect(command('9')).toEqual({ name: 'volume', amount: -2 });
  expect(command('{', page, { shiftKey: true })).toEqual({
    name: 'speed-half',
  });
  expect(command('Backspace')).toEqual({ name: 'speed-reset' });
  expect(command('L', page, { shiftKey: true })).toEqual({
    name: 'repeat-one',
  });
});

test('other keys and modifiers go to the page', () => {
  expect(command('l')).toBeUndefined();
  expect(command('q')).toBeUndefined();
  expect(command('Enter', page, { shiftKey: true })).toBeUndefined();
  expect(command('[', page, { metaKey: true })).toBeUndefined();
  expect(command('ArrowLeft', page, { ctrlKey: true })).toBeUndefined();
  expect(command('ArrowRight', page, { altKey: true })).toBeUndefined();
  expect(command('p', page, { isComposing: true })).toBeUndefined();
  expect(keyName(press('ArrowLeft', page, { shiftKey: true }))).toBe(
    'Shift+LEFT',
  );
  expect(keyName(press(' '))).toBe('SPACE');
});

test('keys stay with text fields, also inside shadow roots', () => {
  const host = element('YTMUSIC-SEARCH-BOX');
  for (const target of [
    element('INPUT'),
    element('TEXTAREA'),
    element('SELECT'),
    element('DIV', {}, true),
    element('DIV', { role: 'textbox' }),
  ]) {
    expect(command(' ', [target, host, body])).toBeUndefined();
    expect(command('p', [target, host, body])).toBeUndefined();
    expect(command('ArrowLeft', [target, host, body])).toBeUndefined();
  }
});

test('keys stay with the focused control that needs them', () => {
  const button = element('BUTTON');
  expect(command(' ', [button, body])).toBeUndefined();
  expect(command('Enter', [button, body])).toBeUndefined();
  expect(command('Enter', [element('A', { href: '/' }), body])).toBeUndefined();
  expect(
    command(' ', [element('TP-YT-PAPER-ICON-BUTTON', { role: 'button' })]),
  ).toBeUndefined();
  expect(
    command(' ', [element('DIV', { tabindex: '0' }), body]),
  ).toBeUndefined();
  // A button has no use for arrows or characters
  expect(command('ArrowLeft', [button, body])).toEqual({
    name: 'seek',
    amount: -5,
  });
  expect(command('m', [button, body])).toEqual({ name: 'mute' });
  // A slider's knob in its shadow root
  const slider = [
    element('DIV'),
    element('TP-YT-PAPER-SLIDER', { role: 'slider' }),
    body,
  ];
  expect(command('ArrowLeft', slider)).toBeUndefined();
  expect(command('ArrowUp', slider)).toBeUndefined();
  expect(command(' ', slider)).toEqual({ name: 'play-pause' });
  const item = [
    element('TP-YT-PAPER-ITEM', { role: 'option' }),
    element('TP-YT-PAPER-LISTBOX', { role: 'listbox' }),
    body,
  ];
  expect(command('ArrowDown', item)).toBeUndefined();
  expect(command('Enter', item)).toBeUndefined();
  expect(command('m', item)).toBeUndefined();
  expect(
    command('ArrowRight', [
      element('DIV', { role: 'tab' }),
      element('DIV', { role: 'tablist' }),
    ]),
  ).toBeUndefined();
  // A container that takes focus from a script is no control
  expect(command(' ', [element('DIV', { tabindex: '-1' }), body])).toEqual({
    name: 'play-pause',
  });
});

test('the keys option is checked entry by entry', () => {
  const { bindings: custom, skipped } = parseKeys({
    'k': 'play-pause',
    'Shift+UP': 'volume 5',
    'Shift+p': 'next',
    'LEFTT': 'seek -5',
    'x': 'quit',
    'y': 'seek',
    'z': 'seek ten',
    'w': 42,
  });
  expect([...custom]).toEqual([
    ['k', { name: 'play-pause' }],
    ['Shift+UP', { name: 'volume', amount: 5 }],
  ]);
  expect(skipped).toEqual([
    '"Shift+p": "next"',
    '"LEFTT": "seek -5"',
    '"x": "quit"',
    '"y": "seek"',
    '"z": "seek ten"',
    '"w": 42',
  ]);
  // A key left out of the option is unbound
  expect(commandFor(press('p'), custom)).toBeUndefined();
  expect(
    commandFor(press('ArrowUp', page, { shiftKey: true }), custom),
  ).toEqual({
    name: 'volume',
    amount: 5,
  });
});

test('a missing keys option means the defaults', () => {
  expect(parseKeys(undefined)).toEqual({ bindings, skipped: [] });
});

test('a keys option that is no map falls back to the defaults', () => {
  for (const keys of ['p', ['p'], null]) {
    const parsed = parseKeys(keys);
    expect(parsed.skipped).toEqual([JSON.stringify(keys)]);
    expect(parsed.bindings).toEqual(bindings);
  }
});

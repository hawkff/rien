import { test, expect } from '@playwright/test';

import { romanize } from './romanize';

test('romanizes the scripts the native module leaves out', async () => {
  expect(await romanize('ko', '안녕하세요 大韓民國')).toBe(
    'annyeonghaseyo daehanminguk',
  );
  expect(await romanize('zh', '你好 world')).toBe('nǐ hǎo world');
  expect(await romanize('hi', 'नमस्ते दुनिया')).toBe('namaste duniya');
  expect(await romanize('bn', 'আমি তোমাকে ভালোবাসি')).toBe('ami tomake bhalovasi');
  // Word breaks come from the runtime's ICU data
  expect(await romanize('th', 'สวัสดีครับ')).toMatch(/^[a-z ]+$/);
});

test('leaves a line of an unknown language as it is', async () => {
  expect(await romanize('constructor', 'stays')).toBe('stays');
  expect(await romanize('xx', 'stays')).toBe('stays');
});

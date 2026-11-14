import { test, expect } from '@playwright/test';

import { cleanLink } from './clean-link';

const music = 'https://music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com';

test('links to the site keep what names the item and lose the rest', () => {
  // As Share > Copy link gives it
  expect(
    cleanLink(`${music}/watch?v=5NV6Rdv1a3I&si=u79_UAffxWeqwSrg&drli=1`),
  ).toBe(`${music}/watch?v=5NV6Rdv1a3I`);
  // Share's "Start at"
  expect(cleanLink(`${music}/watch?v=5NV6Rdv1a3I&si=x&t=3`)).toBe(
    `${music}/watch?v=5NV6Rdv1a3I&t=3`,
  );
  // The page's own address while a radio plays
  expect(
    cleanLink(`${music}/watch?v=5NV6Rdv1a3I&list=RDAMVM5NV6Rdv1a3I#x`),
  ).toBe(`${music}/watch?v=5NV6Rdv1a3I`);
  expect(cleanLink(`${music}/playlist?list=PLx&si=abc`)).toBe(
    `${music}/playlist?list=PLx`,
  );
  expect(cleanLink(` ${music}/browse/MPREb_x?si=abc `)).toBe(
    `${music}/browse/MPREb_x`,
  );
  expect(cleanLink('https://youtu.be/5NV6Rdv1a3I?si=abc&t=10')).toBe(
    'https://youtu.be/5NV6Rdv1a3I?t=10',
  );
});

test('other text stays as it is', () => {
  for (const text of [
    'https://example.com/?si=x',
    'Faint (Demo 2002)',
    `${music}/watch?v=5NV6Rdv1a3I`,
    // A link with words after it, which the parser would join to the link
    `${music}/watch?v=5NV6Rdv1a3I&si=x\nNotes`,
    `Listen: ${music}/watch?v=5NV6Rdv1a3I&si=x`,
    '',
  ]) {
    expect(cleanLink(text)).toBe(text);
  }
});

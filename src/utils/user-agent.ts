// Electron's user agent names the app and Electron next to Chrome. Google
// serves its current pages, the dark sign-in page among them, only to a
// browser's user agent, so the app sends Chrome's.
export const browserUserAgent = (userAgent: string) =>
  userAgent
    .replace(
      /\(KHTML, like Gecko\) .+? Chrome\//,
      '(KHTML, like Gecko) Chrome/',
    )
    .replace(/ Electron\/\S+/, '');

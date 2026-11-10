// The pages that get the app's bridge and page script: the music site, the
// Google pages it sends the window to for sign-in and consent, and local files
// such as the app's error page. Any other site gets neither.
export const isAppPage = ({
  protocol,
  hostname,
}: Pick<URL, 'protocol' | 'hostname'>) =>
  protocol === 'file:' ||
  (protocol === 'https:' &&
    /(^|\.)(\u0079\u006f\u0075\u0074\u0075\u0062\u0065|google)\.com$/.test(
      hostname,
    ));

import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

// Marks a guest instance. Its value is the account's profile folder, which the
// guest needs for the single-instance lock and for the way back.
export const GUEST_SWITCH = 'rien-guest';

// The account's folder is part of the name, so cleanup touches only the guest
// profiles of the account whose lock this instance holds.
const guestPrefix = (accountDir: string) =>
  `rien-guest-${createHash('sha256').update(accountDir).digest('hex').slice(0, 12)}-`;

type GuestConfig = {
  plugins?: {
    scrobbler?: {
      enabled?: boolean;
      scrobblers?: {
        lastfm?: { token?: string; sessionKey?: string };
        listenbrainz?: { token?: string };
      };
    };
  };
} | null;

// A private folder (mkdtemp creates it with mode 0700) holding only the
// account's config.json: settings and plugins, no cookies or site data.
export const createGuestProfile = (tempDir: string, accountDir: string) => {
  const guestDir = mkdtempSync(path.join(tempDir, guestPrefix(accountDir)));
  let config: GuestConfig;
  try {
    config = JSON.parse(
      readFileSync(path.join(accountDir, 'config.json'), 'utf8'),
    ) as GuestConfig;
  } catch (error) {
    // Without a config the guest starts with the defaults
    if (
      !(error instanceof SyntaxError) &&
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw error;
    }
    return guestDir;
  }
  // The scrobblers' sign-ins belong to the account, so a guest's plays stay
  // out of its listening history. Turned off, the plugin doesn't ask the guest
  // to sign in at start.
  const scrobbler = config?.plugins?.scrobbler;
  if (scrobbler) {
    scrobbler.enabled = false;
    delete scrobbler.scrobblers?.lastfm?.token;
    delete scrobbler.scrobblers?.lastfm?.sessionKey;
    delete scrobbler.scrobblers?.listenbrainz?.token;
  }
  writeFileSync(path.join(guestDir, 'config.json'), JSON.stringify(config));
  return guestDir;
};

// Runs at a normal start, when no guest of this account can be running: the
// guest holds the account's single-instance lock.
export const removeGuestProfiles = (tempDir: string, accountDir: string) => {
  const prefix = guestPrefix(accountDir);
  let entries;
  try {
    entries = readdirSync(tempDir, { withFileTypes: true });
  } catch (error) {
    console.warn('Could not read the temporary folder', tempDir, error);
    return;
  }
  for (const entry of entries) {
    // Dirent types come from lstat, so a symlink under that name is skipped.
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    try {
      rmSync(path.join(tempDir, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 3,
      });
    } catch (error) {
      console.warn('Could not remove guest profile', entry.name, error);
    }
  }
};

const withoutProfileSwitches = (args: string[]) =>
  args.filter(
    (arg) =>
      !arg.startsWith('--user-data-dir=') &&
      !arg.startsWith(`--${GUEST_SWITCH}=`),
  );

export const guestArgs = (
  args: string[],
  guestDir: string,
  accountDir: string,
) => [
  ...withoutProfileSwitches(args),
  `--user-data-dir=${guestDir}`,
  `--${GUEST_SWITCH}=${accountDir}`,
];

export const accountArgs = (args: string[], accountDir: string) => [
  ...withoutProfileSwitches(args),
  `--user-data-dir=${accountDir}`,
];

export const guestTitle = (guestLabel: string, pageTitle: string) =>
  pageTitle ? `${guestLabel} — ${pageTitle}` : guestLabel;

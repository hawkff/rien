// Rien's proxy: one proxy, or a list of exits that Rien moves along when
// YouTube distrusts the one in use. Google asks signed-out players on such a
// network to "confirm you're not a bot" and refuses some of its requests; a
// cleaner exit gets through.
import { deepmerge } from 'deepmerge-ts';
import { ipcMain, session } from 'electron';

import * as config from '@/config';
import { defaultAuthProxyConfig } from '@/plugins/auth-proxy-adapter/config';
import { exitRules, pacer } from '@/utils/proxy-exits';

export type ExitReason = 'bot-check' | 'refused' | 'manual';
export type ExitChange = {
  exit: number;
  of: number;
  proxy: string;
  reason: ExitReason;
};

const exits = () => config.get('options.proxyExits') ?? [];
const position = () => {
  const count = exits().length;
  const at = config.get('options.proxyExit') ?? 0;
  return count ? ((at % count) + count) % count : 0;
};

/** The proxy rules Rien starts with: its exits from the one in use, or its one proxy */
export const startupProxy = async () => {
  if (exits().length > 0) return exitRules(exits(), position());
  const proxy = config.get('options.proxy');
  if (!proxy) return '';
  if (await config.plugins.isEnabled('auth-proxy-adapter')) {
    // The adapter's local proxy, which logs in to the proxy set
    const { hostname, port } = deepmerge(
      defaultAuthProxyConfig,
      config.get('plugins.auth-proxy-adapter') ?? {},
    ) as typeof defaultAuthProxyConfig;
    return `socks5://${hostname}:${port}`;
  }
  return proxy;
};

const useExit = async (at: number, reason: ExitReason) => {
  const list = exits();
  config.set('options.proxyExit', at);
  // New requests go through it; the sockets of the exit before stay in a
  // pool of their own
  await session.defaultSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: exitRules(list, at),
  });
  const change: ExitChange = {
    exit: at + 1,
    of: list.length,
    proxy: list[at],
    reason,
  };
  // For the API server's live feed, as the page's events reach it
  ipcMain.emit('peard:exit-changed', {}, change);
};

// Each exit at most once every 10 minutes when Rien moves by itself
const allow = pacer(10 * 60 * 1000);

/** Moves to the next exit; false when there is none to move to */
export const nextExit = async (reason: ExitReason) => {
  const count = exits().length;
  if (count < 2 || (reason !== 'manual' && !allow(count))) return false;
  await useExit((position() + 1) % count, reason);
  return true;
};

/** After the list changed: its first exit, or else Rien's one proxy, now */
export const applyExits = async () => {
  if (exits().length > 0) return useExit(0, 'manual');
  const proxy = await startupProxy();
  await session.defaultSession.setProxy(
    proxy ? { mode: 'fixed_servers', proxyRules: proxy } : { mode: 'system' },
  );
};

export const setupProxyExits = () => {
  // The page asks when YouTube distrusts the exit, never to move by hand
  ipcMain.handle('peard:next-exit', (_, reason: unknown) =>
    nextExit(reason === 'refused' ? 'refused' : 'bot-check'),
  );
};

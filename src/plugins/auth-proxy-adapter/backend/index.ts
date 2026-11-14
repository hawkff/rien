import * as config from '@/config';
import { createBackend, LoggerPrefix } from '@/utils';
import { withoutLogin } from '@/utils/proxy-exits';
import { socksRelay } from '@/utils/socks-relay';

import type { AuthProxyConfig } from '../config';
import type { BackendType } from './types';
import type { BackendContext } from '@/types/contexts';

export const backend = createBackend<BackendType, AuthProxyConfig>({
  async start(ctx: BackendContext<AuthProxyConfig>) {
    const pluginConfig = await ctx.getConfig();
    this.startServer(pluginConfig);
  },
  stop() {
    this.stopServer();
  },
  onConfigChange(config: AuthProxyConfig) {
    if (
      this.oldConfig?.hostname === config.hostname &&
      this.oldConfig?.port === config.port
    ) {
      this.oldConfig = config;
      return;
    }
    this.stopServer();
    this.startServer(config);

    this.oldConfig = config;
  },

  // Custom
  // A SOCKS5 server without a login, which Rien's proxy points to, for the
  // proxy set in Options, which needs one
  startServer({ hostname, port }: AuthProxyConfig) {
    if (this.server) {
      this.stopServer();
    }

    const server = socksRelay(() => config.get('options.proxy'));
    server.on('error', (err) => {
      console.error(LoggerPrefix, '[SOCKS Server Error]', err.message);
    });
    server.listen(port, hostname, () => {
      console.log(
        LoggerPrefix,
        `[Auth-Proxy-Adapter] socks5://${hostname}:${port} goes through ${withoutLogin(config.get('options.proxy'))}`,
      );
    });
    this.server = server;
  },

  // Stop proxy server
  stopServer() {
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
  },
});

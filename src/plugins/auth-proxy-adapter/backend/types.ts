import type { AuthProxyConfig } from '../config';
import type { Server } from 'node:net';

export type BackendType = {
  server?: Server;
  oldConfig?: AuthProxyConfig;
  startServer: (serverConfig: AuthProxyConfig) => void;
  stopServer: () => void;
};

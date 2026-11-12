export enum AuthStrategy {
  AUTH_AT_FIRST = 'AUTH_AT_FIRST',
  NONE = 'NONE',
}

export interface APIServerConfig {
  enabled: boolean;
  hostname: string;
  port: number;
  authStrategy: AuthStrategy;
  secret: string;

  authorizedClients: string[];
  useHttps: boolean;
  certPath: string;
  keyPath: string;
}

export const defaultAPIServerConfig: APIServerConfig = {
  enabled: false,
  // Only this computer; set 0.0.0.0 to reach it from other devices
  hostname: '127.0.0.1',
  port: 26538,
  authStrategy: AuthStrategy.AUTH_AT_FIRST,
  // Random. Not randomUUID, which the window's first, empty page lacks.
  secret: Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) =>
    part.toString(36),
  ).join(''),

  authorizedClients: [],
  useHttps: false,
  certPath: '',
  keyPath: '',
};

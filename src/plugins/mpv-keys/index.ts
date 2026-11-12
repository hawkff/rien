import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { backend } from './backend';
import { renderer } from './renderer';

export type MpvKeysConfig = {
  enabled: boolean;
  // Key name to command, as in mpv's input.conf. Left out of the defaults so
  // that an entry deleted from config.json stays unbound.
  keys?: Record<string, string>;
};

export default createPlugin<
  typeof backend,
  unknown,
  typeof renderer,
  MpvKeysConfig
>({
  name: () => t('plugins.mpv-keys.name'),
  description: () => t('plugins.mpv-keys.description'),
  restartNeeded: false,
  config: {
    enabled: false,
  },
  backend,
  renderer,
});

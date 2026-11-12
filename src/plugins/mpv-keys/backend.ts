import { Notification } from 'electron';

import * as config from '@/config';
import { t } from '@/i18n';
import { createBackend } from '@/utils';

import { defaultKeys } from './keys';

import type { MpvKeysConfig } from './index';

// A notification that nothing holds can be collected before it is clicked
const open = new Set<Notification>();

export const backend = createBackend<unknown, MpvKeysConfig>({
  async start({ ipc, getConfig, setConfig }) {
    ipc.handle('mpv-keys:notify', (body: string) => {
      const notification = new Notification({
        title: t('plugins.mpv-keys.name'),
        body,
      });
      notification.on('click', () => {
        config.edit();
      });
      notification.on('close', () => open.delete(notification));
      open.add(notification);
      notification.show();
    });
    // Puts mpv's defaults into config.json, where they can be edited
    if ((await getConfig()).keys === undefined) {
      await setConfig({ keys: defaultKeys });
    }
  },
  stop({ ipc }) {
    ipc.removeHandler('mpv-keys:notify');
  },
});

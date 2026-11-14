import { createRoute, z } from '@hono/zod-openapi';

import { isHeadless } from '@/providers/headless';
import { LoggerPrefix } from '@/utils';
import { linkHost, readViewerMessage } from '@/utils/remote-view';

import { API_VERSION } from '../api-version';
import {
  isViewKey,
  newViewLink,
  remoteView,
  takePairingCode,
  type Viewer,
} from '../remote';
import page from '../remote.html?raw';

import type { APIServerConfig } from '../../config';
import type { HonoApp } from '../types';
import type { BackendContext } from '@/types/contexts';
import type { upgradeWebSocket } from '@hono/node-server';

const routes = {
  link: createRoute({
    method: 'post',
    path: `/api/${API_VERSION}/remote`,
    summary: "a link to Rien's window",
    description:
      "Makes a link to a page that shows Rien's window and passes it the mouse and keys, to sign in or answer the site where Rien runs without a display. Only Rien without a display makes one, and only for a request with the pairing code (header X-Pairing-Code). Each link replaces the one before.",
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': { schema: z.object({ url: z.string() }) },
        },
      },
      403: {
        description: 'Rien has a display, or the pairing code is missing',
        content: {
          'application/json': { schema: z.object({ error: z.string() }) },
        },
      },
    },
  }),
};

export const register = (
  app: HonoApp,
  { getConfig, window }: BackendContext<APIServerConfig>,
  uws: typeof upgradeWebSocket,
) => {
  const view = remoteView(window);

  // The page holds no secret: the key comes from the link it was opened with
  app.get('/remote', (ctx) => ctx.html(page));

  app.get(
    '/remote/ws',
    uws(() => {
      let viewer: Viewer | undefined;
      let waiting: NodeJS.Timeout | undefined;
      return {
        onOpen(_event, ws) {
          waiting = setTimeout(() => ws.close(1008, 'Unauthorized'), 10_000);
        },
        onMessage(event, ws) {
          const message =
            typeof event.data === 'string'
              ? readViewerMessage(event.data)
              : undefined;
          if (viewer) {
            if (message) view.input(viewer, message).catch(() => {});
            return;
          }
          // Nothing reaches the window before the key
          if (message?.type !== 'hello' || !isViewKey(message.key)) {
            ws.close(1008, 'Unauthorized');
            return;
          }
          clearTimeout(waiting);
          // The real socket counts what it has yet to send
          const socket = ws.raw as { bufferedAmount?: number } | undefined;
          const joined: Viewer = {
            send: (text) => ws.send(text),
            behind: () => (socket?.bufferedAmount ?? 0) > 2_000_000,
            close: () => ws.close(1008, 'Unauthorized'),
          };
          viewer = joined;
          view.join(joined, message.width, message.height).catch((error) => {
            console.error(LoggerPrefix, "Can't show the window", error);
            ws.close(1011, "Rien can't show its window");
          });
        },
        onClose() {
          clearTimeout(waiting);
          if (viewer) view.leave(viewer);
        },
      };
    }),
  );

  app.openapi(routes.link, async (ctx) => {
    if (!isHeadless()) {
      return ctx.json(
        { error: 'Rien shows its window on its own screen.' },
        403,
      );
    }
    // The window holds the account: only its user on this computer gets in,
    // whatever token the request has
    if (!takePairingCode(ctx.req.header('x-pairing-code'))) {
      return ctx.json(
        {
          error:
            "Only ytmpc run by the same user on Rien's computer gets a link to the window.",
        },
        403,
      );
    }
    const config = await getConfig();
    // The address the client reached Rien at
    const host =
      ctx.req.header('host') ?? linkHost(config.hostname, config.port);
    return ctx.json({ url: newViewLink(host, config.useHttps) }, 200);
  });
};

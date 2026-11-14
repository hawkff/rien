// The remote view: Rien's window in a browser, through the API server, for
// signing in where Rien has no display of its own
import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

/** Whether `given` is the secret, compared in constant time; never an empty one */
export const sameSecret = (given: unknown, secret: string) => {
  if (typeof given !== 'string' || !secret) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The host and port a link names: a server on every address is reached on this computer */
export const linkHost = (hostname: string, port: number) => {
  const host = ['', '0.0.0.0', '::'].includes(hostname)
    ? '127.0.0.1'
    : hostname.includes(':')
      ? `[${hostname}]`
      : hostname;
  return `${host}:${port}`;
};

/** The window's size for a viewer's page, within reason */
export const viewSize = (width: number, height: number): [number, number] => [
  Math.round(Math.min(Math.max(width, 480), 2560)),
  Math.round(Math.min(Math.max(height, 360), 1600)),
];

// CDP's bits: Alt 1, Ctrl 2, Meta 4, Shift 8
const modifiers = z.number().int().min(0).max(15);

/** What the viewer's page sends */
const ViewerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    key: z.string(),
    width: z.number(),
    height: z.number(),
  }),
  z.object({ type: z.literal('size'), width: z.number(), height: z.number() }),
  z.object({
    type: z.literal('mouse'),
    event: z.enum([
      'mousePressed',
      'mouseReleased',
      'mouseMoved',
      'mouseWheel',
    ]),
    x: z.number(),
    y: z.number(),
    button: z.enum(['none', 'left', 'middle', 'right']),
    clickCount: z.number().int().min(0).max(3),
    deltaX: z.number(),
    deltaY: z.number(),
    modifiers,
  }),
  z.object({
    type: z.literal('key'),
    event: z.enum(['keyDown', 'rawKeyDown', 'keyUp']),
    key: z.string().max(32),
    code: z.string().max(32),
    text: z.string().max(4).optional(),
    keyCode: z.number().int().min(0).max(255),
    modifiers,
  }),
  z.object({ type: z.literal('text'), text: z.string().max(10_000) }),
]);
export type ViewerMessage = z.infer<typeof ViewerMessageSchema>;

/** A message of the viewer's page, or undefined for anything else */
export const readViewerMessage = (text: string) => {
  try {
    return ViewerMessageSchema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
};

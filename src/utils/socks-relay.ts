// A SOCKS5 server on this computer, without a login, that sends each
// connection on through a proxy that needs one. Chromium can't log in to a
// SOCKS proxy, and its login prompt for HTTP proxies reaches pages only.
import net from 'node:net';
import tls from 'node:tls';

import { SocksClient } from 'socks';

// A SOCKS5 answer: 0 success, 5 refused, 7 command not supported
const reply = (code: number) =>
  Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);

/** Where a SOCKS5 CONNECT request goes; undefined for anything else */
export const socksTarget = (data: Buffer) => {
  if (data[0] !== 0x05 || data[1] !== 0x01) return undefined;
  switch (data[3]) {
    case 0x01:
      return {
        host: [...data.subarray(4, 8)].join('.'),
        port: data.readUInt16BE(8),
      };
    case 0x03: {
      const length = data[4];
      return {
        host: data.subarray(5, 5 + length).toString(),
        port: data.readUInt16BE(5 + length),
      };
    }
    case 0x04:
      return {
        host: Array.from({ length: 8 }, (_, at) =>
          data.readUInt16BE(4 + at * 2).toString(16),
        ).join(':'),
        port: data.readUInt16BE(20),
      };
    default:
      return undefined;
  }
};

// An HTTP proxy's tunnel: CONNECT with the login, then the bytes as they come
const httpTunnel = (
  proxy: URL,
  host: string,
  port: number,
  login: string,
  deadline: number,
): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const proxyHost = proxy.hostname.replace(/^\[|\]$/g, '');
    const secure = proxy.protocol === 'https:';
    const proxyPort = Number(proxy.port) || (secure ? 443 : 80);
    const socket = secure
      ? tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost })
      : net.connect(proxyPort, proxyHost);
    const target = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
    // A proxy that closes or keeps quiet before its answer fails the tunnel
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const closed = () => fail(new Error('The proxy closed without an answer'));
    const timer = setTimeout(
      () => fail(new Error('The proxy sent no answer in time')),
      deadline,
    );
    socket.once('error', fail);
    socket.once('close', closed);
    socket.once(secure ? 'secureConnect' : 'connect', () =>
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
          (login
            ? `Proxy-Authorization: Basic ${Buffer.from(login).toString('base64')}\r\n`
            : '') +
          '\r\n',
      ),
    );
    let head = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 16_384) fail(new Error('The proxy sent no answer'));
        return;
      }
      clearTimeout(timer);
      socket.off('data', read);
      socket.off('error', fail);
      socket.off('close', closed);
      socket.pause();
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(
        head.subarray(0, end).toString('latin1'),
      )?.[1];
      if (status !== '200') {
        socket.destroy();
        reject(new Error(`The proxy answered ${status ?? 'something else'}`));
        return;
      }
      // Bytes the server sent right after the answer belong to the tunnel
      if (end + 4 < head.length) socket.unshift(head.subarray(end + 4));
      resolve(socket);
    };
    socket.on('data', read);
  });

/** A connection to host:port through `upstream`, a proxy address with a login */
export const throughProxy = async (
  upstream: string,
  host: string,
  port: number,
  deadline = 15_000,
) => {
  const proxy = new URL(upstream);
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  if (proxy.protocol === 'http:' || proxy.protocol === 'https:') {
    return httpTunnel(
      proxy,
      host,
      port,
      username || password ? `${username}:${password}` : '',
      deadline,
    );
  }
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: Number(proxy.port),
      type: proxy.protocol === 'socks4:' ? 4 : 5,
      userId: username || undefined,
      password: password || undefined,
    },
    command: 'connect',
    destination: { host, port },
    timeout: deadline,
  });
  return socket;
};

/** The relay: a server to listen with, for the proxy `upstream` gives */
export const socksRelay = (upstream: () => string) =>
  net.createServer((client) => {
    client.on('error', () => client.destroy());
    client.once('data', (hello: Buffer) => {
      // Rien's own requests, so no login on this side
      if (hello[0] !== 0x05 || !hello.subarray(2, 2 + hello[1]).includes(0)) {
        client.end(Buffer.from([0x05, 0xff]));
        return;
      }
      client.write(Buffer.from([0x05, 0x00]));
      client.once('data', (request: Buffer) => {
        const target = socksTarget(request);
        if (!target) {
          client.end(reply(0x07));
          return;
        }
        throughProxy(upstream(), target.host, target.port).then(
          (tunnel) => {
            client.write(reply(0x00));
            tunnel.pipe(client);
            client.pipe(tunnel);
            tunnel.on('error', () => client.destroy());
            tunnel.on('close', () => client.destroy());
            client.on('close', () => tunnel.destroy());
          },
          () => client.end(reply(0x05)),
        );
      });
    });
  });

import net from 'node:net';

import { test, expect } from '@playwright/test';
import { SocksClient } from 'socks';

import { socksRelay, socksTarget, throughProxy } from './socks-relay';

const listen = (server: net.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as net.AddressInfo).port),
    ),
  );
const tunnel = (client: net.Socket, host: string, port: number) => {
  const upstream = net.connect(port, host);
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  return upstream;
};

// A SOCKS5 proxy that wants a username and password (RFC 1929)
const socksProxy = (login: string, seen: string[]) =>
  net.createServer((client) => {
    client.once('data', (hello: Buffer) => {
      if (!hello.subarray(2, 2 + hello[1]).includes(0x02)) {
        client.end(Buffer.from([0x05, 0xff]));
        return;
      }
      client.write(Buffer.from([0x05, 0x02]));
      client.once('data', (auth: Buffer) => {
        const userLength = auth[1];
        const user = auth.subarray(2, 2 + userLength).toString();
        const passwordLength = auth[2 + userLength];
        const password = auth
          .subarray(3 + userLength, 3 + userLength + passwordLength)
          .toString();
        seen.push(`${user}:${password}`);
        if (`${user}:${password}` !== login) {
          client.end(Buffer.from([0x01, 0x01]));
          return;
        }
        client.write(Buffer.from([0x01, 0x00]));
        client.once('data', (request: Buffer) => {
          const target = socksTarget(request)!;
          const upstream = tunnel(client, target.host, target.port);
          upstream.on('connect', () => {
            client.write(Buffer.from([0x05, 0, 0, 0x01, 0, 0, 0, 0, 0, 0]));
            upstream.pipe(client);
            client.pipe(upstream);
          });
        });
      });
    });
  });

// An HTTP proxy that wants a login for its CONNECT
const httpProxy = (login: string, seen: (string | null)[]) =>
  net.createServer((client) => {
    client.once('data', (head: Buffer) => {
      const text = head.toString('latin1');
      const target = /^CONNECT (\S+) HTTP/.exec(text)![1];
      const basic = /\r\nProxy-Authorization: Basic (\S+)/i.exec(text)?.[1];
      seen.push(basic ? Buffer.from(basic, 'base64').toString() : null);
      if (basic !== Buffer.from(login).toString('base64')) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      const at = target.lastIndexOf(':');
      const upstream = tunnel(
        client,
        target.slice(0, at),
        Number(target.slice(at + 1)),
      );
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
    });
  });

// Sends a line through the relay to an echo server and gives back the answer
const echoThrough = async (relayPort: number, echoPort: number) => {
  const { socket } = await SocksClient.createConnection({
    proxy: { host: '127.0.0.1', port: relayPort, type: 5 },
    command: 'connect',
    destination: { host: 'localhost', port: echoPort },
  });
  const answer = new Promise<string>((resolve) =>
    socket.once('data', (data) => resolve(data.toString())),
  );
  socket.write('ping');
  const text = await answer;
  socket.destroy();
  return text;
};

test('a SOCKS5 request names its target', () => {
  const domain = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, 11]),
    Buffer.from('example.com'),
    Buffer.from([0x01, 0xbb]),
  ]);
  expect(socksTarget(domain)).toEqual({ host: 'example.com', port: 443 });
  expect(
    socksTarget(Buffer.from([0x05, 0x01, 0x00, 0x01, 10, 0, 0, 9, 0, 80])),
  ).toEqual({ host: '10.0.0.9', port: 80 });
  const ipv6 = Buffer.alloc(22);
  ipv6.set([0x05, 0x01, 0x00, 0x04]);
  ipv6.writeUInt16BE(1, 18);
  ipv6.writeUInt16BE(1080, 20);
  expect(socksTarget(ipv6)).toEqual({ host: '0:0:0:0:0:0:0:1', port: 1080 });
  // Only CONNECT
  expect(socksTarget(Buffer.from([0x05, 0x02, 0x00, 0x01]))).toBeUndefined();
});

test('the relay logs in to a SOCKS5 or an HTTP proxy for its clients', async () => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo);
  const socksSeen: string[] = [];
  const socks = socksProxy('alice:s@cret', socksSeen);
  const socksPort = await listen(socks);
  const httpSeen: (string | null)[] = [];
  const http = httpProxy('bob:pw', httpSeen);
  const httpPort = await listen(http);

  // The login as an exit holds it, escaped in the address
  let upstream = `socks5://alice:s%40cret@127.0.0.1:${socksPort}`;
  const relay = socksRelay(() => upstream);
  const relayPort = await listen(relay);
  try {
    expect(await echoThrough(relayPort, echoPort)).toBe('ping');
    expect(socksSeen).toEqual(['alice:s@cret']);

    upstream = `http://bob:pw@127.0.0.1:${httpPort}`;
    expect(await echoThrough(relayPort, echoPort)).toBe('ping');
    expect(httpSeen).toEqual(['bob:pw']);

    // A wrong login ends in a refusal, not in a hanging connection
    upstream = `http://bob:wrong@127.0.0.1:${httpPort}`;
    await expect(echoThrough(relayPort, echoPort)).rejects.toThrow();
    upstream = `socks5://alice:wrong@127.0.0.1:${socksPort}`;
    await expect(echoThrough(relayPort, echoPort)).rejects.toThrow();
  } finally {
    for (const server of [relay, echo, socks, http]) server.close();
  }
});

test('a proxy that closes or keeps quiet fails the tunnel instead of holding it', async () => {
  const closing = net.createServer((socket) => socket.destroy());
  const quiet = net.createServer(() => {});
  const closingPort = await listen(closing);
  const quietPort = await listen(quiet);
  try {
    await expect(
      throughProxy(
        `http://bob:pw@127.0.0.1:${closingPort}`,
        'example.com',
        443,
      ),
    ).rejects.toThrow('closed');
    const started = Date.now();
    await expect(
      throughProxy(
        `http://bob:pw@127.0.0.1:${quietPort}`,
        'example.com',
        443,
        200,
      ),
    ).rejects.toThrow('in time');
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    closing.close();
    quiet.close();
  }
});

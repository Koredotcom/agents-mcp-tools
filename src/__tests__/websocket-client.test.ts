import { afterEach, describe, expect, test, vi } from 'vitest';
import { once } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { WebSocketClient } from '../client/websocket-client.js';
import type { ServerMessage } from '../types.js';

interface WebSocketServerHarness {
  url: string;
  requestedProtocols: string[];
  protocolHistory: string[][];
  connectionCount: () => number;
  nextConnection: () => Promise<WebSocket>;
  nextMessage: () => Promise<string>;
  close: () => Promise<void>;
}

const servers: WebSocketServerHarness[] = [];
const tcpServers: Server[] = [];
const tcpSockets: Socket[] = [];

describe('WebSocketClient', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    for (const socket of tcpSockets.splice(0)) socket.destroy();
    await Promise.all(
      tcpServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    vi.restoreAllMocks();
  });

  test('uses the web-debug subprotocol transport when an auth token is present', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    client.setAuthToken('jwt-token');

    await expect(client.connect()).resolves.toBeUndefined();

    expect(server.requestedProtocols).toEqual(['web-debug-auth', 'jwt-token']);
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });

  test('rejects internal websocket connections when no auth token is configured', async () => {
    const errors: string[] = [];
    const client = new WebSocketClient({ url: 'ws://127.0.0.1:1/ws' });
    client.onError = (message) => {
      errors.push(message);
    };

    await expect(client.connect()).rejects.toThrow(
      'Internal runtime WebSocket connections require setAuthToken() before connect().',
    );
    expect(errors).toEqual([
      'Internal runtime WebSocket connections require setAuthToken() before connect().',
    ]);
  });

  test('sends serialized client messages to the connected server', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    client.setAuthToken('jwt-token');

    await client.connect();
    const messagePromise = server.nextMessage();

    client.loadAgent('/tmp/agent.abl', 'project-1');

    expect(JSON.parse(await messagePromise)).toEqual({
      type: 'load_agent',
      agentPath: '/tmp/agent.abl',
      projectId: 'project-1',
    });
    client.disconnect();
  });

  test('dispatches generic and typed server messages', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    const genericMessages: ServerMessage[] = [];
    const infoPromise = new Promise<{ message: string; configured: boolean }>((resolve) => {
      client.onInfo = (message, configured) => resolve({ message, configured });
    });
    client.addMessageHandler((message) => {
      genericMessages.push(message);
    });
    client.setAuthToken('jwt-token');

    await client.connect();
    const socket = await server.nextConnection();
    socket.send(JSON.stringify({ type: 'info', message: 'Runtime ready', configured: true }));

    await expect(infoPromise).resolves.toEqual({
      message: 'Runtime ready',
      configured: true,
    });
    expect(genericMessages).toEqual([{ type: 'info', message: 'Runtime ready', configured: true }]);
    client.disconnect();
  });

  test('surfaces invalid server messages through onError', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    const errorPromise = new Promise<string>((resolve) => {
      client.onError = resolve;
    });
    client.setAuthToken('jwt-token');

    await client.connect();
    const socket = await server.nextConnection();
    socket.send('not-json');

    await expect(errorPromise).resolves.toContain('Failed to parse WebSocket message');
    client.disconnect();
  });

  test('keeps the old socket authoritative until promotion and fences it afterward', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    const messages: ServerMessage[] = [];
    client.addMessageHandler((message) => messages.push(message));
    client.setAuthToken('token-1');
    await client.connect();
    const oldSocket = await server.nextConnection();

    oldSocket.send(
      JSON.stringify({ type: 'info', message: 'during-transition', configured: true }),
    );
    await waitFor(() =>
      messages.some(
        (message) => message.type === 'info' && message.message === 'during-transition',
      ),
    );
    await client.reconnect({ authToken: 'token-2' });
    const activeSocket = await server.nextConnection();
    if (oldSocket.readyState === WebSocket.OPEN) {
      oldSocket.send(JSON.stringify({ type: 'info', message: 'superseded', configured: true }));
    }
    activeSocket.send(JSON.stringify({ type: 'info', message: 'active', configured: true }));
    await waitFor(() =>
      messages.some((message) => message.type === 'info' && message.message === 'active'),
    );

    expect(messages).toEqual([
      { type: 'info', message: 'during-transition', configured: true },
      { type: 'info', message: 'active', configured: true },
    ]);
    expect(server.protocolHistory).toEqual([
      ['web-debug-auth', 'token-1'],
      ['web-debug-auth', 'token-2'],
    ]);
    client.disconnect();
  });

  test('preserves automatic reconnect policy after an explicit authenticated replacement', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({
      url: server.url,
      reconnect: true,
      reconnectInterval: 5,
      maxReconnectAttempts: 2,
      connectionTimeoutMs: 500,
    });
    client.setAuthToken('token-1');
    await client.connect();
    await server.nextConnection();

    await client.reconnect({ authToken: 'token-2' });
    const replacementSocket = await server.nextConnection();
    replacementSocket.terminate();
    await withTimeout(server.nextConnection(), 500);
    await waitFor(() => client.isConnected());

    expect(client.isConnected()).toBe(true);
    expect(server.protocolHistory).toEqual([
      ['web-debug-auth', 'token-1'],
      ['web-debug-auth', 'token-2'],
      ['web-debug-auth', 'token-2'],
    ]);
    client.disconnect();
  });

  test('buffers candidate messages until promotion and then replays them', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    const messages: ServerMessage[] = [];
    client.addMessageHandler((message) => messages.push(message));
    client.setAuthToken('token-1');
    await client.connect();
    await server.nextConnection();

    const preparation = client.prepareReplacement({ authToken: 'token-2' });
    const candidateSocket = await server.nextConnection();
    candidateSocket.send(
      JSON.stringify({ type: 'info', message: 'candidate-ready', configured: true }),
    );
    const prepared = await preparation;
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(messages).toEqual([]);
    expect(prepared.isReady()).toBe(true);

    prepared.commit();
    await waitFor(() => messages.length === 1);

    expect(messages).toEqual([{ type: 'info', message: 'candidate-ready', configured: true }]);
    client.disconnect();
  });

  test('refuses promotion when a candidate closes after opening and keeps the old socket live', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    client.setAuthToken('token-1');
    await client.connect();
    await server.nextConnection();

    const preparation = client.prepareReplacement({ authToken: 'token-2' });
    const candidateSocket = await server.nextConnection();
    const prepared = await preparation;
    candidateSocket.close();
    await waitFor(() => !prepared.isReady());

    expect(() => prepared.commit()).toThrow(
      'Replacement WebSocket closed before it could be promoted.',
    );

    expect(client.getUrl()).toBe(server.url);
    expect(client.getAuthToken()).toBe('token-1');
    expect(client.isConnected()).toBe(true);
    expect(server.protocolHistory).toEqual([
      ['web-debug-auth', 'token-1'],
      ['web-debug-auth', 'token-2'],
    ]);
    client.disconnect();
  });

  test('invalidates a candidate whose pre-promotion message buffer exceeds its bound', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    client.setAuthToken('token-1');
    await client.connect();
    await server.nextConnection();

    const preparation = client.prepareReplacement({ authToken: 'token-2' });
    const candidateSocket = await server.nextConnection();
    const prepared = await preparation;
    for (let index = 0; index <= 100; index++) {
      if (candidateSocket.readyState !== WebSocket.OPEN) break;
      candidateSocket.send(
        JSON.stringify({ type: 'info', message: `buffered-${index}`, configured: true }),
      );
    }
    await waitFor(() => !prepared.isReady());

    expect(() => prepared.commit()).toThrow(
      'Replacement WebSocket closed before it could be promoted.',
    );

    expect(client.getAuthToken()).toBe('token-1');
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });

  test('invalidates a candidate frame that exceeds the candidate byte cap', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    client.setAuthToken('token-1');
    await client.connect();
    await server.nextConnection();

    const preparation = client.prepareReplacement({ authToken: 'token-2' });
    const candidateSocket = await server.nextConnection();
    const prepared = await preparation;
    candidateSocket.send('x'.repeat(300 * 1024));
    await waitFor(() => !prepared.isReady());

    expect(() => prepared.commit()).toThrow(
      'Replacement WebSocket closed before it could be promoted.',
    );
    expect(client.getAuthToken()).toBe('token-1');
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });

  test('expires an abandoned prepared candidate without disturbing the active socket', async () => {
    const server = await createWebSocketServer();
    // Keep the handshake budget separate from the lease assertion so parallel CI
    // scheduling cannot fail the setup before the candidate is prepared.
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    client.setAuthToken('token-1');
    await client.connect();
    await server.nextConnection();

    const preparation = client.prepareReplacement({ authToken: 'token-2' });
    await server.nextConnection();
    const prepared = await preparation;
    expect(prepared.isReady()).toBe(true);

    await waitFor(() => !prepared.isReady(), 1000);

    expect(client.getAuthToken()).toBe('token-1');
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });

  test('cancels a pending automatic reconnect when explicitly disconnected', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({
      url: server.url,
      reconnect: true,
      reconnectInterval: 50,
      maxReconnectAttempts: 2,
      connectionTimeoutMs: 500,
    });
    client.setAuthToken('token-1');
    await client.connect();
    const socket = await server.nextConnection();
    const disconnected = new Promise<void>((resolve) => {
      client.onDisconnected = resolve;
    });

    socket.terminate();
    await disconnected;
    client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(server.connectionCount()).toBe(1);
    expect(client.isConnected()).toBe(false);
  });

  test('times out a TCP connection that never completes the WebSocket handshake', async () => {
    const url = await createHangingTcpServer();
    const client = new WebSocketClient({ url, connectionTimeoutMs: 20 });
    client.setAuthToken('jwt-token');

    await expect(client.connect()).rejects.toMatchObject({
      name: 'ConnectionTimeoutError',
      message: expect.stringContaining('timed out'),
    });
    expect(client.isConnected()).toBe(false);
  });

  test('fences a connection attempt that is explicitly superseded before opening', async () => {
    const url = await createHangingTcpServer();
    const client = new WebSocketClient({ url, connectionTimeoutMs: 100 });
    client.setAuthToken('jwt-token');

    const connecting = client.connect();
    await new Promise((resolve) => setTimeout(resolve, 5));
    client.disconnect();

    await expect(connecting).rejects.toThrow('WebSocket connection was superseded.');
    expect(client.isConnected()).toBe(false);
  });

  test('rejects a timed-out handshake after its connection generation is superseded', async () => {
    const url = await createHangingTcpServer();
    const client = new WebSocketClient({ url, connectionTimeoutMs: 20 });
    client.setAuthToken('jwt-token');

    const connecting = client.connect();
    (
      client as unknown as {
        connectionGeneration: number;
      }
    ).connectionGeneration++;

    await expect(connecting).rejects.toThrow('WebSocket connection was superseded.');
    client.disconnect();
  });

  test('fences an opening socket after a newer connection generation is published', async () => {
    const acceptance = deferred<boolean>();
    const server = await createWebSocketServer(acceptance.promise);
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    client.setAuthToken('jwt-token');

    const connecting = client.connect();
    await new Promise((resolve) => setTimeout(resolve, 5));
    (
      client as unknown as {
        connectionGeneration: number;
      }
    ).connectionGeneration++;
    acceptance.resolve(true);

    await expect(connecting).rejects.toThrow('WebSocket connection was superseded.');
    client.disconnect();
  });

  test('rejects replacement without credentials and enforces single-use finalization', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });

    await expect(client.prepareReplacement()).rejects.toThrow(
      'require an auth token before replacement',
    );

    client.setAuthToken('token-1');
    const committed = await client.prepareReplacement({ authToken: 'token-2' });
    committed.commit();
    expect(() => committed.commit()).toThrow('already been finalized');

    const aborted = await client.prepareReplacement({ authToken: 'token-3' });
    aborted.abort();
    expect(aborted.isReady()).toBe(false);
    expect(() => aborted.abort()).not.toThrow();
    client.disconnect();
  });

  test('reconnect rejects an unready prepared replacement', async () => {
    const client = new WebSocketClient();
    const abort = vi.fn();
    vi.spyOn(client, 'prepareReplacement').mockResolvedValue({
      isReady: () => false,
      commit: vi.fn(),
      abort,
    });

    await expect(client.reconnect({ authToken: 'token-2' })).rejects.toThrow(
      'Replacement WebSocket closed before it could be promoted.',
    );
    expect(abort).toHaveBeenCalledOnce();
  });

  test('times out a replacement candidate without changing the configured token', async () => {
    const url = await createHangingTcpServer();
    const client = new WebSocketClient({ url, connectionTimeoutMs: 20 });
    client.setAuthToken('token-1');

    await expect(client.prepareReplacement({ authToken: 'token-2' })).rejects.toMatchObject({
      name: 'ConnectionTimeoutError',
    });
    expect(client.getAuthToken()).toBe('token-1');
    expect(client.isConnected()).toBe(false);
  });

  test('disconnect discards all prepared candidates before they can be promoted', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    client.setAuthToken('token-1');
    const first = await client.prepareReplacement({ authToken: 'token-2' });
    const second = await client.prepareReplacement({ authToken: 'token-3' });

    client.disconnect();

    expect(first.isReady()).toBe(false);
    expect(second.isReady()).toBe(false);
    expect(() => first.commit()).toThrow('closed before it could be promoted');
    expect(() => second.commit()).toThrow('closed before it could be promoted');
  });

  test('does not replay a candidate buffer after the promoted socket is immediately closed', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    const messages: ServerMessage[] = [];
    client.addMessageHandler((message) => messages.push(message));
    client.setAuthToken('token-1');

    const preparation = client.prepareReplacement({ authToken: 'token-2' });
    const candidateSocket = await server.nextConnection();
    candidateSocket.send(
      JSON.stringify({ type: 'info', message: 'must-not-replay', configured: true }),
    );
    const prepared = await preparation;
    await new Promise((resolve) => setTimeout(resolve, 2));

    prepared.commit();
    client.disconnect();
    await Promise.resolve();

    expect(messages).toEqual([]);
  });

  test('can disconnect while preserving the configured reconnect policy', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({
      url: server.url,
      reconnect: true,
      reconnectInterval: 5,
      connectionTimeoutMs: 500,
    });
    client.setAuthToken('token-1');
    await client.connect();

    client.disconnect({ preserveReconnectPolicy: true });
    await client.connect();

    expect(server.connectionCount()).toBe(2);
    client.disconnect();
  });

  test('rejects a replacement candidate closed during the opening handshake', async () => {
    const server = await createWebSocketServer(false);
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    client.setAuthToken('token-1');

    await expect(client.prepareReplacement()).rejects.toThrow();
    expect(client.isConnected()).toBe(false);
  });

  test('routes protocol errors from a promoted candidate through the active error handler', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    const errorPromise = new Promise<string>((resolve) => {
      client.onError = resolve;
    });
    client.setAuthToken('token-1');

    const replacement = await client.prepareReplacement({ authToken: 'token-2' });
    const promotedSocket = await server.nextConnection();
    replacement.commit();
    const rawSocket = (promotedSocket as WebSocket & { _socket: Socket })._socket;
    rawSocket.write(Buffer.from([0x83, 0x00]));

    await expect(errorPromise).resolves.toContain('Invalid WebSocket frame');
    client.disconnect();
  });

  test('fences a promoted socket message delivered after an immediate disconnect', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({ url: server.url, connectionTimeoutMs: 500 });
    const messages: ServerMessage[] = [];
    client.addMessageHandler((message) => messages.push(message));
    client.setAuthToken('token-1');

    const replacement = await client.prepareReplacement({ authToken: 'token-2' });
    const promotedSocket = await server.nextConnection();
    replacement.commit();
    promotedSocket.send(JSON.stringify({ type: 'info', message: 'late', configured: true }));
    client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(messages).toEqual([]);
  });

  test('contains a failed automatic reconnect after the server becomes unavailable', async () => {
    const server = await createWebSocketServer();
    const client = new WebSocketClient({
      url: server.url,
      reconnect: true,
      reconnectInterval: 5,
      maxReconnectAttempts: 1,
      connectionTimeoutMs: 100,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    client.setAuthToken('token-1');
    await client.connect();
    await server.nextConnection();

    await server.close();
    await waitFor(() => consoleError.mock.calls.length > 0);

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Reconnect failed'),
      expect.any(String),
    );
    expect(client.isConnected()).toBe(false);
    client.disconnect();
  });
});

async function createHangingTcpServer(): Promise<string> {
  const server = createServer();
  server.on('connection', (socket) => {
    tcpSockets.push(socket);
    // Deliberately leave the TCP socket open without completing an HTTP upgrade.
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  tcpServers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server to listen on a numeric port');
  }
  return `ws://127.0.0.1:${address.port}`;
}

async function createWebSocketServer(
  acceptConnections: boolean | Promise<boolean> = true,
): Promise<WebSocketServerHarness> {
  const requestedProtocols: string[] = [];
  const protocolHistory: string[][] = [];
  let acceptedConnectionCount = 0;
  const connectionQueue: WebSocket[] = [];
  const connectionWaiters: Array<(socket: WebSocket) => void> = [];
  const messageQueue: string[] = [];
  const messageWaiters: Array<(message: string) => void> = [];
  let closed = false;
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: (_info, callback) => {
      Promise.resolve(acceptConnections).then((accepted) => {
        callback(accepted, 401, 'Unauthorized');
      });
    },
    handleProtocols: (protocols) => {
      const requested = Array.from(protocols);
      requestedProtocols.splice(0, requestedProtocols.length, ...requested);
      protocolHistory.push(requested);
      return protocols.has('web-debug-auth') ? 'web-debug-auth' : false;
    },
  });

  server.on('connection', (socket) => {
    acceptedConnectionCount++;
    const connectionWaiter = connectionWaiters.shift();
    if (connectionWaiter) {
      connectionWaiter(socket);
    } else {
      connectionQueue.push(socket);
    }

    socket.on('message', (data) => {
      const message = data.toString();
      const messageWaiter = messageWaiters.shift();
      if (messageWaiter) {
        messageWaiter(message);
      } else {
        messageQueue.push(message);
      }
    });
  });

  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected WebSocketServer to listen on a TCP port');
  }

  const harness: WebSocketServerHarness = {
    url: `ws://127.0.0.1:${(address as AddressInfo).port}`,
    requestedProtocols,
    protocolHistory,
    connectionCount: () => acceptedConnectionCount,
    nextConnection: () => {
      const socket = connectionQueue.shift();
      if (socket) {
        return Promise.resolve(socket);
      }

      return new Promise<WebSocket>((resolve) => {
        connectionWaiters.push(resolve);
      });
    },
    nextMessage: () => {
      const message = messageQueue.shift();
      if (message) {
        return Promise.resolve(message);
      }

      return new Promise<string>((resolve) => {
        messageWaiters.push(resolve);
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const client of server.clients) {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          client.close();
        }
      }

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };

  servers.push(harness);
  return harness;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return {
    promise,
    resolve: (value) => {
      if (!resolve) throw new Error('Deferred promise was not initialized');
      resolve(value);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Condition was not reached');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for WebSocket connection')), timeoutMs);
    }),
  ]);
}

/**
 * Tests for connect tool handler
 */

import { afterEach, describe, test, expect, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { connect } from '../tools/connect.js';
import type { DebugContext } from '../tools/index.js';
import { HttpClient } from '../client/http-client.js';
import { WebSocketClient } from '../client/websocket-client.js';
import { SessionStore } from '../store/session-store.js';
import { TraceStore } from '../store/trace-store.js';

const SOURCE_TOKEN = makeJwt({
  sub: 'user-1',
  email: 'developer@example.com',
  tenantId: 'source-tenant',
});
const TARGET_TOKEN = makeJwt({
  sub: 'user-1',
  email: 'developer@example.com',
  tenantId: 'target-tenant',
});

interface TestWebSocketServer {
  url: string;
  attemptedTokens: Array<string | null>;
  close: () => Promise<void>;
}

const realClients: WebSocketClient[] = [];
const testServers: TestWebSocketServer[] = [];

function createMockContext(overrides?: Partial<DebugContext>): DebugContext {
  return {
    wsClient: {
      isConnected: vi.fn().mockReturnValue(false),
      setUrl: vi.fn(),
      getUrl: vi.fn().mockReturnValue('ws://localhost:3112/ws'),
      connect: vi.fn().mockResolvedValue(undefined),
      reconnect: vi.fn().mockResolvedValue(undefined),
      prepareReplacement: vi.fn().mockResolvedValue({
        isReady: vi.fn().mockReturnValue(true),
        commit: vi.fn(),
        abort: vi.fn(),
      }),
      disconnect: vi.fn(),
      setAuthToken: vi.fn(),
      getAuthToken: vi.fn().mockReturnValue('current-jwt'),
    } as any,
    httpClient: {
      setBaseUrl: vi.fn(),
      getBaseUrl: vi.fn().mockReturnValue('http://localhost:3112'),
      getAuthToken: vi.fn().mockReturnValue('current-jwt'),
      setAuthToken: vi.fn(),
      runtimeHealthCheck: vi.fn().mockResolvedValue({ reachable: true, status: 200 }),
    } as any,
    sessionStore: { clear: vi.fn() } as any,
    traceStore: { clear: vi.fn() } as any,
    authenticate: vi.fn().mockResolvedValue({ token: 'test-jwt', method: 'device_auth' }),
    ...overrides,
  };
}

describe('connect tool', () => {
  afterEach(async () => {
    for (const client of realClients.splice(0)) client.disconnect();
    await Promise.all(testServers.splice(0).map((server) => server.close()));
    vi.restoreAllMocks();
  });

  describe('URL resolution', () => {
    test('derives URLs from serverUrl', async () => {
      const ctx = createMockContext();
      await connect({ serverUrl: 'http://myhost:8080' }, ctx);

      expect(ctx.wsClient.prepareReplacement).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'ws://myhost:8080/ws' }),
      );
      expect(ctx.httpClient.setBaseUrl).toHaveBeenCalledWith('http://myhost:8080');
    });

    test('uses legacy wsUrl/httpUrl when serverUrl not provided', async () => {
      const ctx = createMockContext();
      await connect({ wsUrl: 'ws://custom:9999/ws', httpUrl: 'http://custom:9999' }, ctx);

      expect(ctx.wsClient.prepareReplacement).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'ws://custom:9999/ws' }),
      );
      expect(ctx.httpClient.setBaseUrl).toHaveBeenCalledWith('http://custom:9999');
    });

    test('serverUrl takes precedence over legacy params', async () => {
      const ctx = createMockContext();
      await connect(
        {
          serverUrl: 'http://primary:3112',
          wsUrl: 'ws://ignored:9999/ws',
          httpUrl: 'http://ignored:9999',
        },
        ctx,
      );

      expect(ctx.wsClient.prepareReplacement).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'ws://primary:3112/ws' }),
      );
      expect(ctx.httpClient.setBaseUrl).toHaveBeenCalledWith('http://primary:3112');
    });

    test.each([
      { httpUrl: 'https://agents-qa.kore.ai' },
      { wsUrl: 'wss://agents-qa.kore.ai/ws' },
      { httpUrl: 'https://agents-qa.kore.ai', wsUrl: 'ws://127.0.0.1:3112/ws' },
    ])('rejects a partial legacy override that would split remote targets', async (override) => {
      const ctx = createMockContext();
      vi.mocked(ctx.httpClient.getBaseUrl).mockReturnValue('https://agents-dev.kore.ai');
      vi.mocked(ctx.wsClient.getUrl).mockReturnValue('wss://agents-dev.kore.ai/ws');

      const result = JSON.parse(await connect({ ...override, force: true }, ctx));

      expect(result).toMatchObject({
        success: false,
        errorCode: 'INVALID_TARGET_CONFIGURATION',
      });
      expect(ctx.authenticate).not.toHaveBeenCalled();
      expect(ctx.wsClient.prepareReplacement).not.toHaveBeenCalled();
    });

    test('uses defaults when no URLs provided', async () => {
      const ctx = createMockContext();
      await connect({}, ctx);

      expect(ctx.wsClient.prepareReplacement).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'ws://localhost:3112/ws' }),
      );
      expect(ctx.httpClient.setBaseUrl).toHaveBeenCalledWith('http://localhost:3112');
    });

    test('keeps the environment-selection error when no target is configured', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.httpClient.getBaseUrl).mockReturnValue('');
      vi.mocked(ctx.wsClient.getUrl).mockReturnValue('');

      const result = JSON.parse(await connect({}, ctx));

      expect(result).toMatchObject({ success: false });
      expect(result.error).toContain('No server URL configured');
      expect(result.errorCode).toBeUndefined();
    });
  });

  describe('already connected', () => {
    test('returns already_connected when WS is open', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.wsClient.isConnected).mockReturnValue(true);

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.status).toBe('already_connected');
      // Should NOT try health check or auth
      expect(ctx.httpClient.runtimeHealthCheck).not.toHaveBeenCalled();
      expect(ctx.authenticate).not.toHaveBeenCalled();
    });

    test('rejects an environment change without force and leaves the active target untouched', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.wsClient.isConnected).mockReturnValue(true);
      vi.mocked(ctx.httpClient.getBaseUrl).mockReturnValue('https://agents-dev.kore.ai');
      vi.mocked(ctx.wsClient.getUrl).mockReturnValue('wss://agents-dev.kore.ai/ws');

      const result = JSON.parse(
        await connect({ serverUrl: 'https://agents-qa.kore.ai' }, ctx),
      ) as Record<string, unknown>;

      expect(result).toMatchObject({
        success: false,
        errorCode: 'RECONNECT_REQUIRED',
        activeTarget: {
          serverUrl: 'https://agents-dev.kore.ai',
          wsUrl: 'wss://agents-dev.kore.ai/ws',
        },
        requestedTarget: {
          serverUrl: 'https://agents-qa.kore.ai',
          wsUrl: 'wss://agents-qa.kore.ai/ws',
        },
      });
      expect(ctx.httpClient.setBaseUrl).not.toHaveBeenCalled();
      expect(ctx.wsClient.setUrl).not.toHaveBeenCalled();
      expect(ctx.authenticate).not.toHaveBeenCalled();
    });

    test('replaces the authenticated socket before committing a refreshed token', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.wsClient.isConnected).mockReturnValue(true);

      const raw = await connect({ authToken: 'new-jwt-token' }, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.status).toBe('token_refreshed');
      expect(ctx.wsClient.reconnect).toHaveBeenCalledWith({ authToken: 'new-jwt-token' });
      expect(ctx.httpClient.setAuthToken).toHaveBeenCalledWith('new-jwt-token');
      expect(ctx.wsClient.setAuthToken).not.toHaveBeenCalledWith('new-jwt-token');
      // Should NOT use the unauthenticated disconnect/re-authenticate path.
      expect(ctx.wsClient.disconnect).not.toHaveBeenCalled();
      expect(ctx.authenticate).not.toHaveBeenCalled();
    });

    test('normalizes a non-Error authenticated socket replacement failure', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.wsClient.isConnected).mockReturnValue(true);
      vi.mocked(ctx.wsClient.reconnect).mockRejectedValue('socket closed');

      const result = JSON.parse(await connect({ authToken: 'new-jwt-token' }, ctx));

      expect(result).toMatchObject({
        success: false,
        errorCode: 'TOKEN_REFRESH_FAILED',
      });
      expect(result.error).toContain('socket closed');
      expect(ctx.httpClient.setAuthToken).not.toHaveBeenCalled();
    });

    test('force=true disconnects and fully reconnects', async () => {
      const ctx = createMockContext();
      // First call: connected. After disconnect: not connected.
      vi.mocked(ctx.wsClient.isConnected).mockReturnValueOnce(true).mockReturnValue(false);

      const raw = await connect({ force: true }, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.status).toBe('connected');
      expect(ctx.wsClient.disconnect).not.toHaveBeenCalled();
      expect(ctx.authenticate).toHaveBeenCalled();
      expect(ctx.wsClient.prepareReplacement).toHaveBeenCalled();
    });

    test('force=true with authToken disconnects and re-authenticates with new token', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.wsClient.isConnected).mockReturnValueOnce(true).mockReturnValue(false);

      const raw = await connect({ authToken: 'fresh-jwt', force: true }, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.status).toBe('connected');
      expect(ctx.wsClient.disconnect).not.toHaveBeenCalled();
      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          authToken: 'fresh-jwt',
          deferCommit: true,
          serverUrl: 'http://localhost:3112',
        }),
      );
    });
  });

  describe('health check (localhost only)', () => {
    test('returns actionable error when localhost runtime not reachable', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.httpClient.runtimeHealthCheck).mockResolvedValue({ reachable: false });

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Runtime not reachable');
      expect(result.error).toContain('cd apps/runtime && pnpm dev');
      expect(result.hint).toContain('Do NOT try alternative approaches');
      // Should NOT try auth
      expect(ctx.authenticate).not.toHaveBeenCalled();
    });

    test('includes error reason when health check has error details', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.httpClient.runtimeHealthCheck).mockResolvedValue({
        reachable: false,
        error: 'Connection refused: http://localhost:3112/health/live',
        errorCode: 'CONNECTION_REFUSED',
      });

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
      expect(result.errorCode).toBe('CONNECTION_REFUSED');
    });
  });

  describe('remote URL — skips health check', () => {
    test('skips health check for remote URL and goes straight to auth + WS', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.httpClient.getBaseUrl).mockReturnValue('https://agents-dev.kore.ai');
      vi.mocked(ctx.wsClient.getUrl).mockReturnValue('wss://agents-dev.kore.ai/ws');

      const raw = await connect({ serverUrl: 'https://agents-dev.kore.ai' }, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.status).toBe('connected');
      // Health check should NOT be called for remote URLs
      expect(ctx.httpClient.runtimeHealthCheck).not.toHaveBeenCalled();
      // Auth and WS connect should still be called
      expect(ctx.authenticate).toHaveBeenCalled();
      expect(ctx.wsClient.prepareReplacement).toHaveBeenCalled();
    });

    test('returns WS error with details when remote WS connection fails', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.httpClient.getBaseUrl).mockReturnValue('https://agents-dev.kore.ai');
      vi.mocked(ctx.wsClient.getUrl).mockReturnValue('wss://agents-dev.kore.ai/ws');
      const wsError = new Error(
        'WebSocket connection timed out after 10s connecting to wss://agents-dev.kore.ai/ws',
      );
      (wsError as any).name = 'ConnectionTimeoutError';
      vi.mocked(ctx.wsClient.prepareReplacement).mockRejectedValue(wsError);

      const raw = await connect({ serverUrl: 'https://agents-dev.kore.ai' }, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain('WebSocket connection failed');
      expect(result.error).toContain('timed out after 10s');
      expect(ctx.httpClient.runtimeHealthCheck).not.toHaveBeenCalled();
    });
  });

  describe('auth cascade integration', () => {
    test('passes authToken to authenticate', async () => {
      const ctx = createMockContext();

      await connect({ authToken: 'my-jwt' }, ctx);

      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          authToken: 'my-jwt',
          deferCommit: true,
          serverUrl: 'http://localhost:3112',
        }),
      );
    });

    test('returns auth method on success', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.authenticate).mockResolvedValue({ token: 'jwt', method: 'stored_credentials' });

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.authMethod).toBe('stored_credentials');
    });

    test('returns error with hint when auth fails', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.authenticate).mockRejectedValue(new Error('All auth methods failed'));

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Authentication failed');
      expect(result.hint).toContain('Do NOT try alternative approaches');
    });
  });

  describe('WS connection', () => {
    test('connects WS after auth succeeds', async () => {
      const ctx = createMockContext();

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.status).toBe('connected');
      expect(ctx.wsClient.prepareReplacement).toHaveBeenCalled();
    });

    test('returns error with hint when WS connect fails', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.wsClient.prepareReplacement).mockRejectedValue(new Error('ECONNREFUSED'));

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain('WebSocket connection failed');
      expect(result.hint).toContain('Do NOT try alternative approaches');
    });

    test('does not persist or publish credentials when the prepared candidate is no longer ready', async () => {
      const commitCredentials = vi.fn();
      const abort = vi.fn();
      const commit = vi.fn();
      const ctx = createMockContext();
      vi.mocked(ctx.authenticate).mockResolvedValue({
        token: 'target-jwt',
        method: 'device_auth',
        commitCredentials,
      });
      vi.mocked(ctx.wsClient.prepareReplacement).mockResolvedValue({
        isReady: () => false,
        commit,
        abort,
      });

      const result = JSON.parse(await connect({}, ctx));

      expect(result).toMatchObject({
        success: false,
        errorCode: 'CANDIDATE_NOT_READY',
        candidateAborted: true,
      });
      expect(abort).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      expect(commitCredentials).not.toHaveBeenCalled();
      expect(ctx.httpClient.setBaseUrl).not.toHaveBeenCalled();
      expect(ctx.httpClient.setAuthToken).not.toHaveBeenCalled();
      expect(ctx.sessionStore.clear).not.toHaveBeenCalled();
      expect(ctx.traceStore.clear).not.toHaveBeenCalled();
    });

    test('normalizes a non-Error credential lock failure and aborts the candidate', async () => {
      const abort = vi.fn();
      const ctx = createMockContext();
      vi.mocked(ctx.authenticate).mockResolvedValue({
        token: 'target-jwt',
        method: 'device_auth',
        acquireCredentialLock: async () => {
          throw 'credential lock unavailable';
        },
      });
      vi.mocked(ctx.wsClient.prepareReplacement).mockResolvedValue({
        isReady: () => true,
        commit: vi.fn(),
        abort,
      });

      const result = JSON.parse(await connect({}, ctx));

      expect(result).toMatchObject({
        success: false,
        errorCode: 'CREDENTIAL_LOCK_FAILED',
        candidateAborted: true,
      });
      expect(result.error).toContain('credential lock unavailable');
      expect(abort).toHaveBeenCalledOnce();
      expect(ctx.httpClient.setAuthToken).not.toHaveBeenCalled();
    });
  });

  describe('response includes device auth message', () => {
    test('forwards auth message from device auth flow', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.authenticate).mockResolvedValue({
        token: 'device-jwt',
        method: 'device_auth',
        message: 'Please visit http://example.com to approve',
      });

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.message).toContain('Please visit');
    });
  });

  describe('atomic environment transitions', () => {
    test('keeps the published source context live while a forced target handshake is pending', async () => {
      const sourceServer = await createTestWebSocketServer((token) => token === SOURCE_TOKEN);
      const targetDecision = deferred<boolean>();
      const targetServer = await createTestWebSocketServer(() => targetDecision.promise);
      const harness = await createRealContext(sourceServer.url);

      const transition = connect(
        {
          httpUrl: websocketToHttpUrl(targetServer.url),
          wsUrl: targetServer.url,
          authToken: TARGET_TOKEN,
          force: true,
        },
        harness.ctx,
      );
      await waitFor(() => targetServer.attemptedTokens.length === 1);

      expect(harness.httpClient.getBaseUrl()).toBe(websocketToHttpUrl(sourceServer.url));
      expect(harness.wsClient.getUrl()).toBe(sourceServer.url);
      expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
      expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
      expect(harness.wsClient.isConnected()).toBe(true);
      expect(harness.sessionClear).not.toHaveBeenCalled();
      expect(harness.traceClear).not.toHaveBeenCalled();

      targetDecision.resolve(false);
      const result = JSON.parse(await transition);

      expect(result).toMatchObject({
        success: false,
        activeTarget: {
          serverUrl: websocketToHttpUrl(sourceServer.url),
          tenantId: 'source-tenant',
        },
      });
      expect(harness.wsClient.isConnected()).toBe(true);
      expect(sourceServer.attemptedTokens).toEqual([SOURCE_TOKEN]);
    });

    test('replaces the authenticated socket before publishing a token refresh', async () => {
      const server = await createTestWebSocketServer(
        (token) => token === SOURCE_TOKEN || token === TARGET_TOKEN,
      );
      const harness = await createRealContext(server.url);

      const result = JSON.parse(await connect({ authToken: TARGET_TOKEN }, harness.ctx));

      expect(result).toMatchObject({
        success: true,
        status: 'token_refreshed',
        contextReset: true,
        activeTarget: {
          environment: 'local',
          tenantId: 'target-tenant',
          subject: 'user-1',
        },
      });
      expect(server.attemptedTokens).toEqual([SOURCE_TOKEN, TARGET_TOKEN]);
      expect(harness.httpClient.getAuthToken()).toBe(TARGET_TOKEN);
      expect(harness.wsClient.getAuthToken()).toBe(TARGET_TOKEN);
      expect(harness.wsClient.isConnected()).toBe(true);
      expect(harness.sessionClear).toHaveBeenCalledOnce();
      expect(harness.traceClear).toHaveBeenCalledOnce();
      expect(harness.ctx.authenticate).not.toHaveBeenCalled();
    });

    test('clears stale debug context when a disconnected client reconnects as another workspace', async () => {
      const server = await createTestWebSocketServer(
        (token) => token === SOURCE_TOKEN || token === TARGET_TOKEN,
      );
      const harness = await createRealContext(server.url);
      harness.wsClient.disconnect();

      const result = JSON.parse(await connect({ authToken: TARGET_TOKEN }, harness.ctx)) as Record<
        string,
        unknown
      >;

      expect(result).toMatchObject({
        success: true,
        status: 'connected',
        contextReset: true,
        activeTarget: {
          tenantId: 'target-tenant',
          subject: 'user-1',
        },
      });
      expect(server.attemptedTokens).toEqual([SOURCE_TOKEN, TARGET_TOKEN]);
      expect(harness.sessionClear).toHaveBeenCalledOnce();
      expect(harness.traceClear).toHaveBeenCalledOnce();
      expect(harness.httpClient.getAuthToken()).toBe(TARGET_TOKEN);
      expect(harness.wsClient.getAuthToken()).toBe(TARGET_TOKEN);
    });

    test('leaves the prior URL, tokens, socket, and stores live when the target handshake fails', async () => {
      const sourceServer = await createTestWebSocketServer((token) => token === SOURCE_TOKEN);
      const targetServer = await createTestWebSocketServer(() => false);
      const harness = await createRealContext(sourceServer.url);

      const result = JSON.parse(
        await connect(
          {
            httpUrl: websocketToHttpUrl(targetServer.url),
            wsUrl: targetServer.url,
            authToken: TARGET_TOKEN,
            force: true,
          },
          harness.ctx,
        ),
      );

      expect(result).toMatchObject({
        success: false,
        activeTarget: {
          serverUrl: websocketToHttpUrl(sourceServer.url),
          tenantId: 'source-tenant',
          subject: 'user-1',
        },
      });
      expect(harness.httpClient.getBaseUrl()).toBe(websocketToHttpUrl(sourceServer.url));
      expect(harness.wsClient.getUrl()).toBe(sourceServer.url);
      expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
      expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
      expect(harness.wsClient.isConnected()).toBe(true);
      expect(sourceServer.attemptedTokens).toEqual([SOURCE_TOKEN]);
      expect(targetServer.attemptedTokens).toEqual([TARGET_TOKEN]);
      expect(harness.sessionClear).not.toHaveBeenCalled();
      expect(harness.traceClear).not.toHaveBeenCalled();
    });

    test('aborts an authenticated candidate when deferred credential persistence fails', async () => {
      const sourceServer = await createTestWebSocketServer((token) => token === SOURCE_TOKEN);
      const targetServer = await createTestWebSocketServer((token) => token === TARGET_TOKEN);
      const harness = await createRealContext(sourceServer.url, () => {
        throw new Error('credential store is read-only');
      });

      const result = JSON.parse(
        await connect(
          {
            httpUrl: websocketToHttpUrl(targetServer.url),
            wsUrl: targetServer.url,
            authToken: TARGET_TOKEN,
            force: true,
          },
          harness.ctx,
        ),
      );

      expect(result).toMatchObject({
        success: false,
        errorCode: 'CREDENTIAL_PERSISTENCE_FAILED',
        activeTarget: {
          serverUrl: websocketToHttpUrl(sourceServer.url),
          tenantId: 'source-tenant',
        },
        candidateAborted: true,
      });
      expect(String(result.error)).toContain('credential store is read-only');
      expect(sourceServer.attemptedTokens).toEqual([SOURCE_TOKEN]);
      expect(targetServer.attemptedTokens).toEqual([TARGET_TOKEN]);
      expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
      expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
      expect(harness.wsClient.isConnected()).toBe(true);
      expect(harness.sessionClear).not.toHaveBeenCalled();
      expect(harness.traceClear).not.toHaveBeenCalled();
    });

    test('publishes the new identity and clears stale context only after all stages succeed', async () => {
      const sourceServer = await createTestWebSocketServer((token) => token === SOURCE_TOKEN);
      const targetServer = await createTestWebSocketServer((token) => token === TARGET_TOKEN);
      const commitCredentials = vi.fn();
      const harness = await createRealContext(sourceServer.url, commitCredentials);

      const result = JSON.parse(
        await connect(
          {
            httpUrl: websocketToHttpUrl(targetServer.url),
            wsUrl: targetServer.url,
            authToken: TARGET_TOKEN,
            force: true,
          },
          harness.ctx,
        ),
      );

      expect(result).toMatchObject({
        success: true,
        status: 'connected',
        contextReset: true,
        activeTarget: {
          environment: 'local',
          serverUrl: websocketToHttpUrl(targetServer.url),
          tenantId: 'target-tenant',
          subject: 'user-1',
        },
      });
      expect(commitCredentials).toHaveBeenCalledOnce();
      expect(harness.httpClient.getAuthToken()).toBe(TARGET_TOKEN);
      expect(harness.wsClient.getAuthToken()).toBe(TARGET_TOKEN);
      expect(harness.wsClient.isConnected()).toBe(true);
      expect(harness.sessionClear).toHaveBeenCalledOnce();
      expect(harness.traceClear).toHaveBeenCalledOnce();
    });

    test('keeps a successful context credential when a concurrent writer promotion fails', async () => {
      const acquireCredentialLock = createQueuedCredentialLock();
      let storedToken = SOURCE_TOKEN;
      const createContext = (promotionFails: boolean) => {
        const ctx = createMockContext();
        vi.mocked(ctx.authenticate).mockResolvedValue({
          token: TARGET_TOKEN,
          method: 'device_auth',
          acquireCredentialLock,
          commitCredentials: () => {
            const ownsWrite = storedToken === SOURCE_TOKEN;
            if (ownsWrite) storedToken = TARGET_TOKEN;
            return ownsWrite
              ? () => {
                  storedToken = SOURCE_TOKEN;
                }
              : () => undefined;
          },
        });
        vi.mocked(ctx.wsClient.prepareReplacement).mockResolvedValue({
          isReady: () => true,
          commit: () => {
            if (promotionFails) throw new Error('candidate closed');
          },
          abort: () => undefined,
        });
        return ctx;
      };

      const [failed, succeeded] = await Promise.all([
        connect({}, createContext(true)).then(JSON.parse),
        connect({}, createContext(false)).then(JSON.parse),
      ]);

      expect([failed.success, succeeded.success].sort()).toEqual([false, true]);
      expect(storedToken).toBe(TARGET_TOKEN);
    });
  });
});

async function createRealContext(
  sourceWebSocketUrl: string,
  commitCredentials: () => void = () => undefined,
): Promise<{
  ctx: DebugContext;
  httpClient: HttpClient;
  wsClient: WebSocketClient;
  sessionClear: ReturnType<typeof vi.spyOn>;
  traceClear: ReturnType<typeof vi.spyOn>;
}> {
  const httpClient = new HttpClient(websocketToHttpUrl(sourceWebSocketUrl));
  vi.spyOn(httpClient, 'runtimeHealthCheck').mockResolvedValue({ reachable: true, status: 200 });
  const wsClient = new WebSocketClient({
    url: sourceWebSocketUrl,
    connectionTimeoutMs: 500,
  });
  const sessionStore = new SessionStore();
  const traceStore = new TraceStore();
  httpClient.setAuthToken(SOURCE_TOKEN);
  wsClient.setAuthToken(SOURCE_TOKEN);
  sessionStore.createSession('source-session', 'source-agent');
  await wsClient.connect();
  realClients.push(wsClient);

  return {
    httpClient,
    wsClient,
    sessionClear: vi.spyOn(sessionStore, 'clear'),
    traceClear: vi.spyOn(traceStore, 'clear'),
    ctx: {
      httpClient,
      wsClient,
      sessionStore,
      traceStore,
      authenticate: vi.fn(async (options) => {
        expect(options).toMatchObject({ authToken: TARGET_TOKEN, deferCommit: true });
        return { token: TARGET_TOKEN, method: 'explicit_token' as const, commitCredentials };
      }),
    },
  };
}

async function createTestWebSocketServer(
  acceptsToken: (token: string | null) => boolean | Promise<boolean>,
): Promise<TestWebSocketServer> {
  const attemptedTokens: Array<string | null> = [];
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: (info, callback) => {
      const protocols = info.req.headers['sec-websocket-protocol']
        ?.split(',')
        .map((value) => value.trim());
      const token = protocols?.[1] ?? null;
      attemptedTokens.push(token);
      Promise.resolve(acceptsToken(token)).then((accepted) => {
        callback(accepted, 401, 'Unauthorized');
      });
    },
    handleProtocols: (protocols) => (protocols.has('web-debug-auth') ? 'web-debug-auth' : false),
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected WebSocketServer to listen on a TCP port');
  }

  const harness: TestWebSocketServer = {
    url: `ws://127.0.0.1:${(address as AddressInfo).port}`,
    attemptedTokens,
    close: async () => {
      for (const client of server.clients) {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          client.close();
        }
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  testServers.push(harness);
  return harness;
}

function makeJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function websocketToHttpUrl(value: string): string {
  const url = new URL(value);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '';
  return url.toString().replace(/\/$/, '');
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

function createQueuedCredentialLock(): () => Promise<{ release(): void }> {
  let tail = Promise.resolve();
  return async () => {
    const previous = tail;
    let release: (() => void) | undefined;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return { release: () => release?.() };
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Condition was not reached');
}

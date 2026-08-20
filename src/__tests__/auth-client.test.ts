/**
 * Tests for auth-client — authenticate cascade
 */

import { describe, expect, test, vi } from 'vitest';
import {
  acquireDeviceCredentials,
  authenticate,
  DeviceAuthError,
  type AuthDependencies,
} from '../client/auth-client.js';
import type { StoredCredentials } from '../client/credentials.js';
import type { HttpClient } from '../client/http-client.js';
import type { WebSocketClient } from '../client/websocket-client.js';

interface FetchCall {
  url: string;
  options: RequestInit;
  timeoutMs: number;
}

interface RunCommandCall {
  command: string;
  args: string[];
}

interface AuthHarness {
  credentials: StoredCredentials | null;
  readCount: number;
  writtenCredentials: StoredCredentials[];
  fetchCalls: FetchCall[];
  runCommands: RunCommandCall[];
  openedUrls: string[];
  sleepCalls: number[];
  dependencies: AuthDependencies;
}

interface ClientHarness {
  httpClient: HttpClient;
  wsClient: WebSocketClient;
  httpTokens: string[];
  wsTokens: string[];
}

const BASE_URL = 'http://localhost:3112';
const STUDIO_AUTH_URL = 'http://localhost:5173/auth/device?code=ABCD-1234';

const TEST_JWT_PAYLOAD = Buffer.from(
  JSON.stringify({
    sub: 'u-1',
    email: 'test@kore.com',
    tenantId: 'tenant-1',
    exp: 9_999_999_999,
  }),
).toString('base64url');
const TEST_JWT = `eyJ.${TEST_JWT_PAYLOAD}.sig`;

function deviceAuthInitResponse(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    device_code: 'dc-123',
    user_code: 'ABCD-1234',
    verification_uri: 'http://localhost:5173/auth/device',
    verification_uri_complete: STUDIO_AUTH_URL,
    expires_in: 900,
    interval: 0.05,
    ...overrides,
  };
}

function deviceTokenResponse(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    access_token: TEST_JWT,
    refresh_token: 'device-refresh',
    expires_in: 86_400,
    ...overrides,
  };
}

describe('authenticate', () => {
  describe('explicit token', () => {
    test('uses authToken directly and sets it on both clients', async () => {
      const clients = createClients();
      const harness = createAuthHarness();

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        { authToken: 'my-jwt' },
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'explicit_token', token: 'my-jwt' });
      expect(clients.httpTokens).toEqual(['my-jwt']);
      expect(clients.wsTokens).toEqual(['my-jwt']);
      expect(harness.readCount).toBe(0);
      expect(harness.fetchCalls).toHaveLength(0);
    });

    test('wins over stored credentials', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        credentials: validCredentials('stored-jwt'),
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        { authToken: 'explicit-jwt' },
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'explicit_token', token: 'explicit-jwt' });
      expect(harness.readCount).toBe(0);
    });

    test('stages an explicit token without mutating either client', async () => {
      const clients = createClients();
      const harness = createAuthHarness();

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        { authToken: 'staged-jwt', deferCommit: true },
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'explicit_token', token: 'staged-jwt' });
      expect(clients.httpTokens).toEqual([]);
      expect(clients.wsTokens).toEqual([]);
    });
  });

  describe('stored credentials', () => {
    test('does not send a valid legacy token without server scope to the selected environment', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        credentials: {
          token: makeJwt({ sub: 'user-1', tenantId: 'tenant-1' }),
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        {},
        harness.dependencies,
      );

      expect(result.method).toBe('device_auth');
      expect(harness.fetchCalls.map((call) => call.url)).toEqual([
        'http://localhost:5173/api/auth/device',
        'http://localhost:5173/api/auth/device/token',
      ]);
    });

    test.each([
      { name: 'empty token', token: '' },
      { name: 'opaque token', token: 'opaque-token' },
      {
        name: 'primitive JWT payload',
        token: `eyJ.${Buffer.from(JSON.stringify('not-an-object')).toString('base64url')}.sig`,
      },
      { name: 'missing tenant', token: makeJwt({ sub: 'user-1' }) },
      { name: 'missing subject', token: makeJwt({ tenantId: 'tenant-1' }) },
    ])('rejects a valid stored $name before target validation', async ({ token }) => {
      const clients = createClients();
      const harness = createAuthHarness({
        credentials: {
          token,
          expiresAt: '2099-01-01T00:00:00.000Z',
          serverUrl: BASE_URL,
        },
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        {},
        harness.dependencies,
      );

      expect(result.method).toBe('device_auth');
      expect(harness.fetchCalls.map((call) => call.url)).toEqual([
        'http://localhost:5173/api/auth/device',
        'http://localhost:5173/api/auth/device/token',
      ]);
    });

    test('does not reuse credentials scoped to a different server', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        credentials: {
          ...validCredentials('qa-token'),
          serverUrl: 'https://agents-qa.kore.ai',
        },
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        {},
        harness.dependencies,
      );

      expect(result.method).toBe('device_auth');
      expect(clients.httpTokens).not.toContain('qa-token');
      expect(harness.writtenCredentials[0]).toMatchObject({ serverUrl: BASE_URL });
    });

    test('falls through to device auth when the server rejects a cached token', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        credentials: validCredentials('revoked-token'),
        fetchResponses: [
          jsonResponse({ error: 'unauthorized' }, { status: 401 }),
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        {},
        harness.dependencies,
      );

      expect(result.method).toBe('device_auth');
      expect(clients.httpTokens).not.toContain('revoked-token');
    });

    test('uses a valid stored token before device auth', async () => {
      const clients = createClients();
      const credentials = validCredentials('stored-jwt');
      const harness = createAuthHarness({
        credentials,
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        {},
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'stored_credentials', token: credentials.token });
      expect(clients.httpTokens).toEqual([credentials.token]);
      expect(clients.wsTokens).toEqual([credentials.token]);
      expect(harness.fetchCalls).toHaveLength(1);
      expect(harness.fetchCalls[0]?.url).toBe('http://localhost:5173/api/auth/me');
    });

    test('stages a valid stored token without publishing it to either client', async () => {
      const clients = createClients();
      const credentials = validCredentials('stored-jwt');
      const harness = createAuthHarness({ credentials });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        { deferCommit: true },
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'stored_credentials', token: credentials.token });
      expect(clients.httpTokens).toEqual([]);
      expect(clients.wsTokens).toEqual([]);
    });

    test.each([
      {
        name: 'rotates refresh token when the refresh response provides one',
        refreshBody: { accessToken: TEST_JWT, refreshToken: 'rotated-refresh', expiresIn: 86_400 },
        expectedRefreshToken: 'rotated-refresh',
      },
      {
        name: 'keeps existing refresh token when the refresh response does not rotate it',
        refreshBody: { accessToken: TEST_JWT, expiresIn: 86_400 },
        expectedRefreshToken: 'keep-refresh',
      },
    ])('$name', async ({ refreshBody, expectedRefreshToken }) => {
      const clients = createClients();
      const scopedAccessToken = makeJwt({
        sub: 'user-1',
        email: 'keep@example.com',
        tenantId: 'tenant-1',
        exp: 9_999_999_999,
      });
      const scopedRefreshBody = { ...refreshBody, accessToken: scopedAccessToken };
      const harness = createAuthHarness({
        credentials: expiredCredentials(
          makeJwt({ sub: 'user-1', email: 'keep@example.com', tenantId: 'tenant-1' }),
          {
            refreshToken: 'keep-refresh',
            email: 'keep@example.com',
            serverUrl: BASE_URL,
          },
        ),
        fetchResponses: [jsonResponse(scopedRefreshBody)],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        {},
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'stored_credentials', token: scopedAccessToken });
      expect(harness.fetchCalls[0]).toMatchObject({
        url: 'http://localhost:5173/api/auth/refresh',
        options: { method: 'POST' },
        timeoutMs: 15_000,
      });
      expect(readCallBody(harness, 0)).toMatchObject({
        refresh_token: 'keep-refresh',
        refreshToken: 'keep-refresh',
        tenantId: 'tenant-1',
      });
      expect(harness.writtenCredentials[0]).toMatchObject({
        token: scopedAccessToken,
        refreshToken: expectedRefreshToken,
        email: 'keep@example.com',
      });
    });

    test('shares one refresh across concurrent contexts and commits one credential lineage', async () => {
      const original = expiredCredentials(makeJwt({ sub: 'user-1', tenantId: 'tenant-1' }), {
        refreshToken: 'shared-refresh',
        serverUrl: BASE_URL,
      });
      const refreshedToken = makeJwt({ sub: 'user-1', tenantId: 'tenant-1', generation: 2 });
      let stored: StoredCredentials | null = original;
      let fetchCount = 0;
      let resolveRefresh!: (response: Response) => void;
      const refreshResponse = new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
      const writes: StoredCredentials[] = [];
      const dependencies: AuthDependencies = {
        readStoredCredentials: () => stored,
        hasValidToken: () => false,
        hasRefreshToken: (credentials) => Boolean(credentials.refreshToken),
        writeStoredCredentials: (credentials) => {
          writes.push(credentials);
          stored = credentials;
        },
        restoreStoredCredentials: (credentials) => {
          stored = credentials;
        },
        fetchWithTimeout: async () => {
          fetchCount += 1;
          return refreshResponse;
        },
      };

      const first = authenticate(
        createClients().httpClient,
        createClients().wsClient,
        {},
        dependencies,
      );
      const second = authenticate(
        createClients().httpClient,
        createClients().wsClient,
        {},
        dependencies,
      );
      await Promise.resolve();
      resolveRefresh(
        jsonResponse({
          accessToken: refreshedToken,
          refreshToken: 'rotated-refresh',
          expiresIn: 86_400,
        }),
      );

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.token).toBe(refreshedToken);
      expect(secondResult.token).toBe(refreshedToken);
      expect(fetchCount).toBe(1);
      expect(writes).toHaveLength(1);
      expect(stored).toMatchObject({ token: refreshedToken, refreshToken: 'rotated-refresh' });
    });

    test('does not let a deferred refresh follower roll back the shared committed lineage', async () => {
      const original = expiredCredentials(makeJwt({ sub: 'user-1', tenantId: 'tenant-1' }), {
        refreshToken: 'shared-refresh',
        serverUrl: BASE_URL,
      });
      const refreshedToken = makeJwt({ sub: 'user-1', tenantId: 'tenant-1', generation: 2 });
      let stored: StoredCredentials | null = original;
      let resolveRefresh!: (response: Response) => void;
      const refreshResponse = new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
      const dependencies: AuthDependencies = {
        readStoredCredentials: () => stored,
        hasValidToken: () => false,
        hasRefreshToken: (credentials) => Boolean(credentials.refreshToken),
        writeStoredCredentials: (credentials) => {
          stored = credentials;
        },
        restoreStoredCredentials: (credentials) => {
          stored = credentials;
        },
        fetchWithTimeout: async () => refreshResponse,
      };

      const first = authenticate(
        createClients().httpClient,
        createClients().wsClient,
        { deferCommit: true },
        dependencies,
      );
      const second = authenticate(
        createClients().httpClient,
        createClients().wsClient,
        { deferCommit: true },
        dependencies,
      );
      await Promise.resolve();
      resolveRefresh(
        jsonResponse({
          accessToken: refreshedToken,
          refreshToken: 'rotated-refresh',
          expiresIn: 86_400,
        }),
      );
      const [firstResult, secondResult] = await Promise.all([first, second]);

      firstResult.commitCredentials?.();
      const followerRollback = secondResult.commitCredentials?.();
      followerRollback?.();

      expect(stored).toMatchObject({ token: refreshedToken, refreshToken: 'rotated-refresh' });
    });

    test('rejects a reordered refresh response after the stored environment context changes', async () => {
      const original = expiredCredentials(makeJwt({ sub: 'user-1', tenantId: 'tenant-1' }), {
        refreshToken: 'source-refresh',
        serverUrl: BASE_URL,
      });
      const switched = expiredCredentials(makeJwt({ sub: 'user-1', tenantId: 'tenant-2' }), {
        refreshToken: 'target-refresh',
        serverUrl: 'https://agents-qa.kore.ai',
      });
      let stored: StoredCredentials | null = original;
      let resolveRefresh!: (response: Response) => void;
      const refreshResponse = new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
      const writes: StoredCredentials[] = [];
      const clients = createClients();
      const pending = authenticate(
        clients.httpClient,
        clients.wsClient,
        {},
        {
          readStoredCredentials: () => stored,
          hasValidToken: () => false,
          hasRefreshToken: (credentials) => Boolean(credentials.refreshToken),
          writeStoredCredentials: (credentials) => {
            writes.push(credentials);
            stored = credentials;
          },
          restoreStoredCredentials: (credentials) => {
            stored = credentials;
          },
          fetchWithTimeout: async () => refreshResponse,
        },
      );
      await Promise.resolve();
      stored = switched;
      resolveRefresh(
        jsonResponse({
          accessToken: makeJwt({ sub: 'user-1', tenantId: 'tenant-1', generation: 2 }),
          refreshToken: 'rotated-source-refresh',
          expiresIn: 86_400,
        }),
      );

      await expect(pending).rejects.toThrow('changed while token refresh was in progress');
      expect(stored).toEqual(switched);
      expect(writes).toEqual([]);
      expect(clients.httpTokens).toEqual([]);
      expect(clients.wsTokens).toEqual([]);
    });

    test('rejects a deferred refresh commit after the stored context changes', async () => {
      const original = expiredCredentials(makeJwt({ sub: 'user-1', tenantId: 'tenant-1' }), {
        refreshToken: 'source-refresh',
        serverUrl: BASE_URL,
      });
      const switched = expiredCredentials(makeJwt({ sub: 'user-1', tenantId: 'tenant-2' }), {
        refreshToken: 'target-refresh',
        serverUrl: 'https://agents-qa.kore.ai',
      });
      const harness = createAuthHarness({
        credentials: original,
        fetchResponses: [
          jsonResponse({
            accessToken: makeJwt({ sub: 'user-1', tenantId: 'tenant-1', generation: 2 }),
            refreshToken: 'rotated-source-refresh',
            expiresIn: 86_400,
          }),
        ],
      });
      const clients = createClients();
      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        { deferCommit: true },
        harness.dependencies,
      );

      harness.credentials = switched;

      expect(() => result.commitCredentials?.()).toThrow(
        'changed while token refresh was in progress',
      );
      expect(harness.credentials).toEqual(switched);
      expect(harness.writtenCredentials).toEqual([]);
    });

    test('rejects a refresh response scoped to a different workspace without falling through', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        credentials: expiredCredentials(makeJwt({ sub: 'user-1', tenantId: 'tenant-1' }), {
          refreshToken: 'keep-refresh',
          serverUrl: BASE_URL,
        }),
        fetchResponses: [
          jsonResponse({
            accessToken: makeJwt({ sub: 'user-1', tenantId: 'tenant-2' }),
            refreshToken: 'rotated-refresh',
          }),
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      await expect(
        authenticate(clients.httpClient, clients.wsClient, {}, harness.dependencies),
      ).rejects.toThrow('tenant-2');
      expect(clients.httpTokens).toEqual([]);
      expect(clients.wsTokens).toEqual([]);
      expect(harness.fetchCalls).toHaveLength(1);
      expect(harness.writtenCredentials).toEqual([]);
    });

    test('falls through to device auth when stored credentials are expired without refresh', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        credentials: expiredCredentials('expired-jwt'),
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        {},
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'device_auth', token: TEST_JWT });
      expect(harness.openedUrls).toEqual([STUDIO_AUTH_URL]);
      expect(harness.fetchCalls.map((call) => call.url)).toEqual([
        'http://localhost:5173/api/auth/device',
        'http://localhost:5173/api/auth/device/token',
      ]);
    });

    test('falls through to device auth when refresh fails', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        credentials: expiredCredentials(makeJwt({ sub: 'user-1', tenantId: 'tenant-1' }), {
          refreshToken: 'refresh-abc',
          serverUrl: BASE_URL,
        }),
        fetchResponses: [
          new Error('refresh offline'),
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        {},
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'device_auth', token: TEST_JWT });
      expect(harness.fetchCalls.map((call) => call.url)).toEqual([
        'http://localhost:5173/api/auth/refresh',
        'http://localhost:5173/api/auth/device',
        'http://localhost:5173/api/auth/device/token',
      ]);
    });

    test('does not send an unscoped legacy refresh token to the selected environment', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        credentials: expiredCredentials(makeJwt({ sub: 'user-1', tenantId: 'tenant-1' }), {
          refreshToken: 'legacy-refresh',
        }),
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        {},
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'device_auth', token: TEST_JWT });
      expect(harness.fetchCalls.map((call) => call.url)).toEqual([
        'http://localhost:5173/api/auth/device',
        'http://localhost:5173/api/auth/device/token',
      ]);
    });

    test('skips stored credentials when requested', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        credentials: validCredentials('stored-jwt'),
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        { skipStoredCredentials: true },
        harness.dependencies,
      );

      expect(result.method).toBe('device_auth');
      // Stored credentials are not used for authentication, but their identity
      // is snapshotted so the deferred device result cannot overwrite a newer context.
      expect(harness.readCount).toBe(1);
    });
  });

  describe('device auth', () => {
    test('defers client and credential mutation until the caller commits', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        { deferCommit: true },
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'device_auth', token: TEST_JWT });
      expect(result.commitCredentials).toBeTypeOf('function');
      expect(clients.httpTokens).toEqual([]);
      expect(clients.wsTokens).toEqual([]);
      expect(harness.writtenCredentials).toEqual([]);

      const rollback = result.commitCredentials?.();

      expect(clients.httpTokens).toEqual([]);
      expect(clients.wsTokens).toEqual([]);
      expect(harness.writtenCredentials[0]).toMatchObject({
        token: TEST_JWT,
        refreshToken: 'device-refresh',
        serverUrl: BASE_URL,
      });

      rollback?.();
      expect(harness.credentials).toBeNull();
    });

    test('restores an exact prior snapshot after a deferred device credential commit', async () => {
      const prior: StoredCredentials = {
        token: makeJwt({ sub: 'user-1', tenantId: 'tenant-1' }),
        expiresAt: '2099-01-01T00:00:00.000Z',
        serverUrl: BASE_URL,
      };
      const harness = createAuthHarness({
        credentials: prior,
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
      });
      const clients = createClients();

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        { deferCommit: true, skipStoredCredentials: true },
        harness.dependencies,
      );
      const rollback = result.commitCredentials?.();
      expect(harness.credentials).toMatchObject({
        refreshToken: 'device-refresh',
        email: 'test@kore.com',
      });

      rollback?.();
      expect(harness.credentials).toEqual(prior);
      expect(harness.credentials).not.toHaveProperty('refreshToken');
      expect(harness.credentials).not.toHaveProperty('email');
    });

    test('stages a purpose-bound workspace grant without mutating clients or credentials', async () => {
      const harness = createAuthHarness({
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(
            deviceTokenResponse({
              access_token: makeJwt({
                sub: 'user-1',
                tenantId: 'target-tenant',
                role: 'OWNER',
              }),
              refresh_token: 'workspace-refresh',
            }),
          ),
        ],
      });

      const credentials = await acquireDeviceCredentials(
        {
          serverUrl: BASE_URL,
          purpose: 'workspace_switch',
          requestedTenantId: 'target-tenant',
          authorizationToken: 'current-token',
        },
        harness.dependencies,
      );

      expect(credentials).toMatchObject({
        refreshToken: 'workspace-refresh',
        expiresIn: 86_400,
        verificationUrl: STUDIO_AUTH_URL,
        userCode: 'ABCD-1234',
      });
      expect(harness.fetchCalls.map((call) => call.url)).toEqual([
        'http://localhost:5173/api/auth/device',
        'http://localhost:5173/api/auth/device/token',
      ]);
      expect(harness.fetchCalls[0]?.options.headers).toMatchObject({
        Authorization: 'Bearer current-token',
        Origin: 'http://localhost:5173',
      });
      expect(readCallBody(harness, 0)).toEqual({
        scopes: ['read_traces', 'read_state', 'subscribe'],
        purpose: 'workspace_switch',
        requestedTenantId: 'target-tenant',
      });
      expect(readCallBody(harness, 1)).toEqual({ device_code: 'dc-123' });
      expect(harness.writtenCredentials).toEqual([]);
    });

    test('rejects an incomplete workspace grant before issuing a request', async () => {
      const harness = createAuthHarness();

      await expect(
        acquireDeviceCredentials(
          { serverUrl: BASE_URL, purpose: 'workspace_switch' },
          harness.dependencies,
        ),
      ).rejects.toThrow('requires a target workspace and current access token');
      expect(harness.fetchCalls).toEqual([]);
      expect(harness.writtenCredentials).toEqual([]);
    });

    test('single-call flow initiates, opens the browser, polls, and persists credentials', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        {},
        harness.dependencies,
      );

      expect(result).toMatchObject({
        method: 'device_auth',
        token: TEST_JWT,
        message: 'Authenticated via device authorization. Browser login successful.',
      });
      expect(harness.openedUrls).toEqual([STUDIO_AUTH_URL]);
      expect(readCallBody(harness, 0)).toEqual({
        scopes: ['read_traces', 'read_state', 'subscribe'],
      });
      expect(readCallBody(harness, 1)).toEqual({ device_code: 'dc-123' });
      expect(clients.httpTokens).toEqual([TEST_JWT]);
      expect(clients.wsTokens).toEqual([TEST_JWT]);
      expect(harness.writtenCredentials[0]).toMatchObject({
        token: TEST_JWT,
        refreshToken: 'device-refresh',
        email: 'test@kore.com',
      });
    });

    test('honors the server polling interval during the initial device flow', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse({ interval: 5 })),
          jsonResponse(
            { error: 'authorization_pending' },
            { status: 428, statusText: 'Precondition Required' },
          ),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      await expect(
        authenticate(clients.httpClient, clients.wsClient, {}, harness.dependencies),
      ).resolves.toMatchObject({ method: 'device_auth', token: TEST_JWT });

      expect(harness.sleepCalls).toEqual([5_000]);
      expect(harness.fetchCalls).toHaveLength(3);
    });

    test('completes a resumed device auth flow without opening the browser', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [jsonResponse(deviceTokenResponse())],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        { deviceCode: 'dc-123' },
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'device_auth', token: TEST_JWT });
      expect(harness.openedUrls).toHaveLength(0);
      expect(harness.fetchCalls).toHaveLength(1);
      expect(readCallBody(harness, 0)).toEqual({ device_code: 'dc-123' });
    });

    test.each(['  ', `dc-${'x'.repeat(2_048)}`])(
      'rejects an invalid resumed device code before polling',
      async (deviceCode) => {
        const clients = createClients();
        const harness = createAuthHarness({
          fetchResponses: [jsonResponse(deviceTokenResponse())],
        });

        await expect(
          authenticate(clients.httpClient, clients.wsClient, { deviceCode }, harness.dependencies),
        ).rejects.toThrow('code is invalid');

        expect(harness.fetchCalls).toEqual([]);
        expect(harness.writtenCredentials).toEqual([]);
      },
    );

    test('rejects a malformed verification URL before browser launch or token polling', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse({ verification_uri_complete: 'not a url' })),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      await expect(
        authenticate(clients.httpClient, clients.wsClient, {}, harness.dependencies),
      ).rejects.toThrow('invalid verification URL');

      expect(harness.runCommands).toHaveLength(0);
      expect(harness.openedUrls).toHaveLength(0);
      expect(harness.fetchCalls).toHaveLength(1);
      expect(harness.writtenCredentials).toEqual([]);
    });

    test('rejects an oversized device authorization response before JSON allocation', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          new Response('{}', {
            headers: { 'Content-Type': 'application/json', 'Content-Length': '600000' },
          }),
        ],
      });

      await expect(
        authenticate(clients.httpClient, clients.wsClient, {}, harness.dependencies),
      ).rejects.toThrow('response exceeded');

      expect(harness.runCommands).toHaveLength(0);
      expect(harness.writtenCredentials).toEqual([]);
    });

    test('rejects malformed device authorization JSON before browser launch', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          new Response('{', {
            headers: { 'Content-Type': 'application/json' },
          }),
        ],
      });

      await expect(
        authenticate(clients.httpClient, clients.wsClient, {}, harness.dependencies),
      ).rejects.toThrow('malformed JSON');
      expect(harness.runCommands).toHaveLength(0);
      expect(harness.writtenCredentials).toEqual([]);
    });

    test.each([
      { name: 'null object', payload: null },
      { name: 'array', payload: [] },
    ])('rejects a device authorization response encoded as a $name', async ({ payload }) => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [jsonResponse(payload)],
      });

      await expect(
        authenticate(clients.httpClient, clients.wsClient, {}, harness.dependencies),
      ).rejects.toThrow('invalid response');

      expect(harness.runCommands).toHaveLength(0);
      expect(harness.fetchCalls).toHaveLength(1);
      expect(harness.writtenCredentials).toEqual([]);
    });

    test('rejects an array-shaped device token response', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [jsonResponse([])],
      });

      await expect(
        authenticate(
          clients.httpClient,
          clients.wsClient,
          { deviceCode: 'dc-123' },
          harness.dependencies,
        ),
      ).rejects.toThrow('invalid response');

      expect(harness.fetchCalls).toHaveLength(1);
      expect(harness.writtenCredentials).toEqual([]);
    });

    test.each([
      {
        name: 'non-web scheme',
        overrides: {
          verification_uri: 'file:///tmp/device',
          verification_uri_complete: 'file:///tmp/device?code=ABCD-1234',
        },
      },
      {
        name: 'cross-origin URL',
        overrides: {
          verification_uri_complete: 'https://attacker.example/auth/device?code=ABCD-1234',
        },
      },
      {
        name: 'unexpected path',
        overrides: {
          verification_uri_complete: 'http://localhost:5173/auth/callback?code=ABCD-1234',
        },
      },
      {
        name: 'mismatched user code',
        overrides: {
          verification_uri_complete: 'http://localhost:5173/auth/device?code=WXYZ-9876',
        },
      },
      {
        name: 'extra redirect parameter',
        overrides: {
          verification_uri_complete:
            'http://localhost:5173/auth/device?code=ABCD-1234&next=https://attacker.example',
        },
      },
    ])('rejects a $name before browser launch or token polling', async ({ overrides }) => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [jsonResponse(deviceAuthInitResponse(overrides))],
      });

      await expect(
        authenticate(clients.httpClient, clients.wsClient, {}, harness.dependencies),
      ).rejects.toThrow(DeviceAuthError);

      expect(harness.runCommands).toHaveLength(0);
      expect(harness.openedUrls).toHaveLength(0);
      expect(harness.fetchCalls).toHaveLength(1);
      expect(harness.writtenCredentials).toEqual([]);
    });

    test.each([
      { name: 'missing device code', overrides: { device_code: undefined } },
      { name: 'invalid user code', overrides: { user_code: 'invalid code' } },
      { name: 'zero expiry', overrides: { expires_in: 0 } },
      { name: 'excessive expiry', overrides: { expires_in: 3_601 } },
      { name: 'zero interval', overrides: { interval: 0 } },
      { name: 'excessive interval', overrides: { interval: 61 } },
    ])('rejects a device response with $name before polling', async ({ overrides }) => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [jsonResponse(deviceAuthInitResponse(overrides))],
      });

      await expect(
        authenticate(clients.httpClient, clients.wsClient, {}, harness.dependencies),
      ).rejects.toThrow('response fields are invalid');

      expect(harness.runCommands).toHaveLength(0);
      expect(harness.fetchCalls).toHaveLength(1);
      expect(harness.writtenCredentials).toEqual([]);
    });

    test('continues polling when browser launch reports an error', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
        runCommandError: new Error('browser blocked'),
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        {},
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'device_auth', token: TEST_JWT });
      expect(harness.runCommands).toHaveLength(1);
      expect(harness.openedUrls).toEqual([STUDIO_AUTH_URL]);
    });

    test('continues polling when browser launch throws synchronously', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse(deviceTokenResponse()),
        ],
        runCommandThrow: new Error('launcher missing'),
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        {},
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'device_auth', token: TEST_JWT });
      expect(harness.runCommands).toHaveLength(0);
      expect(harness.openedUrls).toHaveLength(0);
    });

    test('throws DeviceAuthError when initiation fails', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          jsonResponse('Internal Server Error', { status: 500, statusText: 'Server Error' }),
        ],
      });

      await expect(
        authenticate(clients.httpClient, clients.wsClient, {}, harness.dependencies),
      ).rejects.toThrow(DeviceAuthError);
    });

    test.each([
      { name: 'missing access token', overrides: { access_token: undefined } },
      { name: 'opaque access token', overrides: { access_token: 'opaque-token' } },
      {
        name: 'access token without tenant identity',
        overrides: { access_token: makeJwt({ sub: 'user-1' }) },
      },
      { name: 'zero expiry', overrides: { expires_in: 0 } },
      { name: 'excessive expiry', overrides: { expires_in: 31 * 24 * 60 * 60 + 1 } },
      { name: 'invalid refresh token', overrides: { refresh_token: 123 } },
    ])(
      'rejects a successful token response with $name without mutating auth state',
      async ({ overrides }) => {
        const clients = createClients();
        const harness = createAuthHarness({
          fetchResponses: [
            jsonResponse(deviceAuthInitResponse()),
            jsonResponse(deviceTokenResponse(overrides)),
          ],
        });

        await expect(
          authenticate(clients.httpClient, clients.wsClient, {}, harness.dependencies),
        ).rejects.toThrow(DeviceAuthError);

        expect(harness.fetchCalls).toHaveLength(2);
        expect(harness.writtenCredentials).toEqual([]);
        expect(clients.httpTokens).toEqual([]);
        expect(clients.wsTokens).toEqual([]);
      },
    );

    test('rejects malformed token JSON without retrying indefinitely', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          jsonResponse(deviceAuthInitResponse()),
          jsonResponse('not-json'),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      await expect(
        authenticate(clients.httpClient, clients.wsClient, {}, harness.dependencies),
      ).rejects.toThrow('malformed JSON');

      expect(harness.fetchCalls).toHaveLength(2);
      expect(harness.sleepCalls).toEqual([]);
      expect(harness.writtenCredentials).toEqual([]);
    });

    test('throws DeviceAuthError when device code expires during polling', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          jsonResponse({ error: 'expired_token' }, { status: 410, statusText: 'Gone' }),
        ],
      });

      await expect(
        authenticate(
          clients.httpClient,
          clients.wsClient,
          { deviceCode: 'dc-123' },
          harness.dependencies,
        ),
      ).rejects.toThrow('expired');
    });

    test.each([
      {
        name: 'authorization_pending',
        firstResponse: jsonResponse(
          { error: 'authorization_pending' },
          { status: 428, statusText: 'Precondition Required' },
        ),
        expectedSleep: 3_000,
      },
      {
        name: 'slow_down',
        firstResponse: jsonResponse(
          { error: 'slow_down' },
          { status: 429, statusText: 'Slow Down' },
        ),
        expectedSleep: 6_000,
      },
    ])('continues polling after $name', async ({ firstResponse, expectedSleep }) => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [firstResponse, jsonResponse(deviceTokenResponse())],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        { deviceCode: 'dc-123', pollTimeoutMs: 30_000 },
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'device_auth', token: TEST_JWT });
      expect(harness.sleepCalls).toEqual([expectedSleep]);
      expect(harness.fetchCalls).toHaveLength(2);
    });

    test('retries a transient Runtime server_error and recovers on the next device-token poll', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          jsonResponse({ error: 'server_error' }, { status: 500, statusText: 'Server Error' }),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        { deviceCode: 'dc-123', pollTimeoutMs: 30_000 },
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'device_auth', token: TEST_JWT });
      expect(harness.sleepCalls).toEqual([6_000]);
      expect(harness.fetchCalls).toHaveLength(2);
    });

    test('retries an ingress 503 with a non-JSON body and recovers on the next poll', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          new Response('<html>temporarily unavailable</html>', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/html' },
          }),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        { deviceCode: 'dc-123', pollTimeoutMs: 30_000 },
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'device_auth', token: TEST_JWT });
      expect(harness.sleepCalls).toEqual([6_000]);
      expect(harness.fetchCalls).toHaveLength(2);
    });

    test('caps repeated Runtime server_error polling backoff', async () => {
      const clients = createClients();
      const transientFailure = () =>
        jsonResponse({ error: 'server_error' }, { status: 500, statusText: 'Server Error' });
      const harness = createAuthHarness({
        fetchResponses: [
          transientFailure(),
          transientFailure(),
          transientFailure(),
          transientFailure(),
          transientFailure(),
          jsonResponse(deviceTokenResponse()),
        ],
      });

      await expect(
        authenticate(
          clients.httpClient,
          clients.wsClient,
          { deviceCode: 'dc-123', pollTimeoutMs: 180_000 },
          harness.dependencies,
        ),
      ).resolves.toMatchObject({ method: 'device_auth', token: TEST_JWT });

      expect(harness.sleepCalls).toEqual([6_000, 12_000, 24_000, 30_000, 30_000]);
      expect(harness.fetchCalls).toHaveLength(6);
    });

    test.each(['token_already_used', 'invalid_grant'])(
      'keeps terminal device-token error %s terminal',
      async (terminalError) => {
        const clients = createClients();
        const harness = createAuthHarness({
          fetchResponses: [jsonResponse({ error: terminalError }, { status: 400 })],
        });

        await expect(
          authenticate(
            clients.httpClient,
            clients.wsClient,
            { deviceCode: 'dc-123', pollTimeoutMs: 30_000 },
            harness.dependencies,
          ),
        ).rejects.toThrow(`Device authorization failed: ${terminalError}`);

        expect(harness.sleepCalls).toEqual([]);
        expect(harness.fetchCalls).toHaveLength(1);
      },
    );

    test('uses the production sleep fallback when no timing dependency is injected', async () => {
      vi.useFakeTimers();

      try {
        const clients = createClients();
        const harness = createAuthHarness({
          fetchResponses: [
            jsonResponse(
              { error: 'authorization_pending' },
              { status: 428, statusText: 'Precondition Required' },
            ),
            jsonResponse(deviceTokenResponse()),
          ],
        });
        const dependencies: AuthDependencies = { ...harness.dependencies };
        delete dependencies.sleep;
        delete dependencies.now;

        const authPromise = authenticate(
          clients.httpClient,
          clients.wsClient,
          { deviceCode: 'dc-123', pollTimeoutMs: 30_000 },
          dependencies,
        );

        await vi.advanceTimersByTimeAsync(3_000);

        await expect(authPromise).resolves.toMatchObject({
          method: 'device_auth',
          token: TEST_JWT,
        });
        expect(harness.sleepCalls).toHaveLength(0);
        expect(harness.fetchCalls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    test('continues polling after a transient token endpoint error', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [new Error('network offline'), jsonResponse(deviceTokenResponse())],
      });

      const result = await authenticate(
        clients.httpClient,
        clients.wsClient,
        { deviceCode: 'dc-123', pollTimeoutMs: 30_000 },
        harness.dependencies,
      );

      expect(result).toMatchObject({ method: 'device_auth', token: TEST_JWT });
      expect(harness.sleepCalls).toEqual([3_000]);
      expect(harness.fetchCalls).toHaveLength(2);
    });

    test('times out when approval never arrives', async () => {
      const clients = createClients();
      const harness = createAuthHarness({
        fetchResponses: [
          jsonResponse(
            { error: 'authorization_pending' },
            { status: 428, statusText: 'Precondition Required' },
          ),
        ],
      });

      await expect(
        authenticate(
          clients.httpClient,
          clients.wsClient,
          { deviceCode: 'dc-123', pollTimeoutMs: 1 },
          harness.dependencies,
        ),
      ).rejects.toThrow('timed out');
      expect(harness.sleepCalls).toEqual([3_000]);
    });
  });
});

function createClients(): ClientHarness {
  const httpTokens: string[] = [];
  const wsTokens: string[] = [];

  return {
    httpTokens,
    wsTokens,
    httpClient: {
      setAuthToken: (token: string) => {
        httpTokens.push(token);
      },
      getBaseUrl: () => BASE_URL,
    } as unknown as HttpClient,
    wsClient: {
      setAuthToken: (token: string) => {
        wsTokens.push(token);
      },
    } as unknown as WebSocketClient,
  };
}

function createAuthHarness(
  input: {
    credentials?: StoredCredentials | null;
    fetchResponses?: Array<Response | Error>;
    nowMs?: number;
    runCommandError?: Error;
    runCommandThrow?: Error;
  } = {},
): AuthHarness {
  const fetchCalls: FetchCall[] = [];
  const runCommands: RunCommandCall[] = [];
  const openedUrls: string[] = [];
  const sleepCalls: number[] = [];
  const writtenCredentials: StoredCredentials[] = [];
  let nowMs = input.nowMs ?? Date.UTC(2026, 0, 1);
  const queue = [...(input.fetchResponses ?? [])];

  const harness: AuthHarness = {
    credentials: input.credentials ?? null,
    readCount: 0,
    writtenCredentials,
    fetchCalls,
    runCommands,
    openedUrls,
    sleepCalls,
    dependencies: undefined as unknown as AuthDependencies,
  };

  harness.dependencies = {
    readStoredCredentials: () => {
      harness.readCount += 1;
      return harness.credentials;
    },
    hasValidToken: (credentials: StoredCredentials) =>
      new Date(credentials.expiresAt).getTime() > nowMs,
    hasRefreshToken: (credentials: StoredCredentials) => Boolean(credentials.refreshToken),
    writeStoredCredentials: (credentials: StoredCredentials) => {
      writtenCredentials.push(credentials);
      harness.credentials = credentials;
    },
    restoreStoredCredentials: (credentials: StoredCredentials | null) => {
      harness.credentials = credentials;
    },
    readMcpStoredCredentials: () => harness.credentials,
    acquireStoredCredentialLock: async () => ({ release: () => undefined }),
    fetchWithTimeout: async (url, options = {}, timeoutMs = 5_000) => {
      fetchCalls.push({ url, options, timeoutMs });
      const next = queue.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next ?? jsonResponse({});
    },
    runCommand: (command, args, callback) => {
      if (input.runCommandThrow) {
        throw input.runCommandThrow;
      }
      runCommands.push({ command, args });
      const openedUrl = args[args.length - 1];
      if (openedUrl) {
        openedUrls.push(openedUrl);
      }
      callback(input.runCommandError ?? null);
    },
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
      nowMs += ms;
    },
    now: () => nowMs,
  };

  return harness;
}

function validCredentials(token: string): StoredCredentials {
  return {
    token: makeJwt({ sub: 'user-1', tenantId: 'tenant-1', testLabel: token }),
    expiresAt: '2099-01-01T00:00:00.000Z',
    serverUrl: BASE_URL,
  };
}

function expiredCredentials(
  token: string,
  overrides: Partial<StoredCredentials> = {},
): StoredCredentials {
  return {
    token,
    expiresAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function readCallBody<T = unknown>(harness: AuthHarness, index: number): T {
  return JSON.parse(harness.fetchCalls[index]?.options.body as string) as T;
}

function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {},
): Response {
  const responseBody = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(responseBody, {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

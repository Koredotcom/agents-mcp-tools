import { afterEach, describe, expect, test, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { HttpClient } from '../client/http-client.js';
import { WebSocketClient } from '../client/websocket-client.js';
import type {
  AcquiredDeviceCredentials,
  DeviceCredentialAcquisitionOptions,
} from '../client/auth-client.js';
import type { StoredCredentials } from '../client/credentials.js';
import { SessionStore } from '../store/session-store.js';
import { TraceStore } from '../store/trace-store.js';
import {
  platformWorkspaces,
  type PlatformWorkspaceDependencies,
} from '../tools/platform-workspaces.js';
import type { DebugContext } from '../tools/index.js';

const SERVER_URL = 'https://agents-dev.kore.ai';
const SOURCE_TOKEN = makeJwt({
  sub: 'user-1',
  email: 'developer@example.com',
  tenantId: 'source-tenant',
  role: 'OWNER',
  exp: 9_999_999_999,
});
const TARGET_TOKEN = makeJwt({
  sub: 'user-1',
  email: 'developer@example.com',
  tenantId: 'target-tenant',
  role: 'ADMIN',
  orgId: 'org-2',
  exp: 9_999_999_999,
});

interface FetchCall {
  url: string;
  options: RequestInit;
  timeoutMs: number;
}

interface WorkspaceContextHarness {
  ctx: DebugContext;
  httpClient: HttpClient;
  wsClient: WebSocketClient;
  sessionClear: ReturnType<typeof vi.spyOn>;
  traceClear: ReturnType<typeof vi.spyOn>;
}

interface DependencyHarness {
  dependencies: PlatformWorkspaceDependencies;
  fetchCalls: FetchCall[];
  deviceCalls: DeviceCredentialAcquisitionOptions[];
  writtenCredentials: StoredCredentials[];
}

interface WebSocketServerHarness {
  url: string;
  attemptedTokens: Array<string | null>;
  closeLatestConnection: () => void;
  close: () => Promise<void>;
}

const clients: WebSocketClient[] = [];
const servers: WebSocketServerHarness[] = [];

describe('platform_workspaces', () => {
  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.disconnect();
    }
    await Promise.all(servers.splice(0).map((server) => server.close()));
    vi.restoreAllMocks();
  });

  test('commits an A-to-B device switch with a target-bound refresh only after websocket authentication', async () => {
    const server = await createWebSocketServer();
    const harness = createWorkspaceContext({ wsUrl: server.url });
    const dependencies = createDependencies({
      storedCredentials: sourceCredentials(),
    });
    await harness.wsClient.connect();

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({
      success: true,
      status: 'switched',
      tenantId: 'target-tenant',
      websocketReconnected: true,
      contextReset: true,
      credentialPersisted: true,
      contextVersion: 1,
      activeTarget: {
        environment: 'development',
        serverUrl: SERVER_URL,
        tenantId: 'target-tenant',
        subject: 'user-1',
        email: 'developer@example.com',
      },
    });
    expect(server.attemptedTokens).toEqual([SOURCE_TOKEN, TARGET_TOKEN]);
    expect(harness.httpClient.getAuthToken()).toBe(TARGET_TOKEN);
    expect(harness.wsClient.getAuthToken()).toBe(TARGET_TOKEN);
    expect(harness.wsClient.isConnected()).toBe(true);
    expect(harness.sessionClear).toHaveBeenCalledOnce();
    expect(harness.traceClear).toHaveBeenCalledOnce();
    expect(dependencies.writtenCredentials).toEqual([
      expect.objectContaining({
        token: TARGET_TOKEN,
        refreshToken: 'workspace-refresh',
        email: 'developer@example.com',
        serverUrl: SERVER_URL,
      }),
    ]);
    expect(dependencies.deviceCalls).toEqual([
      {
        serverUrl: SERVER_URL,
        purpose: 'workspace_switch',
        requestedTenantId: 'target-tenant',
        authorizationToken: SOURCE_TOKEN,
      },
    ]);
    expect(dependencies.fetchCalls).toEqual([]);
    expect(JSON.stringify(result.activeTarget)).not.toContain(TARGET_TOKEN);
  });

  test('retains workspace A while device authorization is pending', async () => {
    const harness = createWorkspaceContext();
    const pendingGrant = deferred<AcquiredDeviceCredentials>();
    const dependencies = createDependencies({
      storedCredentials: sourceCredentials(),
      acquire: async () => pendingGrant.promise,
    });

    const transition = platformWorkspaces(
      { action: 'switch', tenantId: 'target-tenant' },
      harness.ctx,
      dependencies.dependencies,
    );
    await waitFor(() => dependencies.deviceCalls.length === 1);

    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.sessionClear).not.toHaveBeenCalled();
    expect(harness.traceClear).not.toHaveBeenCalled();
    expect(dependencies.writtenCredentials).toEqual([]);
    expect(dependencies.fetchCalls).toEqual([]);

    pendingGrant.resolve({
      accessToken: TARGET_TOKEN,
      refreshToken: 'workspace-refresh',
      expiresIn: 3_600,
    });
    await expect(transition.then(parseResult)).resolves.toMatchObject({
      success: true,
      tenantId: 'target-tenant',
    });
  });

  test('retains workspace A when device authorization fails', async () => {
    const harness = createWorkspaceContext();
    const dependencies = createDependencies({
      storedCredentials: sourceCredentials(),
      acquire: async () => {
        throw new Error('device authorization cancelled');
      },
    });

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: 'WORKSPACE_AUTHORIZATION_FAILED',
      activeWorkspace: 'source-tenant',
    });
    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.sessionClear).not.toHaveBeenCalled();
    expect(harness.traceClear).not.toHaveBeenCalled();
    expect(dependencies.writtenCredentials).toEqual([]);
    expect(dependencies.fetchCalls).toEqual([]);
  });

  test('rejects a device grant without a target refresh credential', async () => {
    const harness = createWorkspaceContext();
    const dependencies = createDependencies({
      storedCredentials: sourceCredentials(),
      acquire: async () => ({ accessToken: TARGET_TOKEN, expiresIn: 3_600 }),
    });

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: 'INVALID_WORKSPACE_RESPONSE',
      activeWorkspace: 'source-tenant',
    });
    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(dependencies.writtenCredentials).toEqual([]);
  });

  test('keeps the source workspace published while the candidate handshake is pending', async () => {
    const targetDecision = deferred<boolean>();
    const server = await createWebSocketServer((token) =>
      token === SOURCE_TOKEN ? true : targetDecision.promise,
    );
    const harness = createWorkspaceContext({ wsUrl: server.url });
    const dependencies = createDependencies();
    await harness.wsClient.connect();

    const transition = platformWorkspaces(
      { action: 'switch', tenantId: 'target-tenant' },
      harness.ctx,
      dependencies.dependencies,
    );
    await waitFor(() => server.attemptedTokens.includes(TARGET_TOKEN));

    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.isConnected()).toBe(true);
    expect(harness.sessionClear).not.toHaveBeenCalled();
    expect(harness.traceClear).not.toHaveBeenCalled();
    expect(dependencies.writtenCredentials).toEqual([]);

    targetDecision.resolve(false);
    const result = parseResult(await transition);

    expect(result).toMatchObject({
      success: false,
      errorCode: 'WORKSPACE_CONNECTION_FAILED',
      activeWorkspace: 'source-tenant',
    });
    expect(harness.wsClient.isConnected()).toBe(true);
    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
  });

  test('stages a token on a disconnected websocket and then commits the new context', async () => {
    const harness = createWorkspaceContext();
    const dependencies = createDependencies();

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({ success: true, websocketReconnected: false });
    expect(harness.httpClient.getAuthToken()).toBe(TARGET_TOKEN);
    expect(harness.wsClient.getAuthToken()).toBe(TARGET_TOKEN);
    expect(harness.sessionClear).toHaveBeenCalledOnce();
    expect(harness.traceClear).toHaveBeenCalledOnce();
  });

  test('rejects an expired workspace token while disconnected without persisting or publishing it', async () => {
    const expiredToken = makeJwt({
      sub: 'user-1',
      tenantId: 'target-tenant',
      role: 'ADMIN',
      orgId: 'org-2',
      exp: 1,
    });
    const harness = createWorkspaceContext();
    const dependencies = createDependencies({
      storedCredentials: sourceCredentials(),
      acquire: async () => ({
        accessToken: expiredToken,
        refreshToken: 'workspace-refresh',
        expiresIn: 3_600,
      }),
    });

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_WORKSPACE_RESPONSE' });
    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(dependencies.writtenCredentials).toEqual([]);
  });

  test.each([
    {
      name: 'same-origin SSO URL',
      redirectUrl: '/api/sso/init?mode=redirect&target=opaque-target',
    },
    { name: 'cross-origin SSO URL', redirectUrl: 'https://attacker.example/steal' },
  ])('never exposes the browser-cookie SSO redirect for a $name', async ({ redirectUrl }) => {
    const harness = createWorkspaceContext();
    const dependencies = createDependencies({
      // This response must remain unread: ordinary tenant switching mutates
      // lastActiveTenantId before the device grant is committed.
      fetchResponses: [
        jsonResponse(
          {
            success: false,
            code: 'SSO_REAUTH_REQUIRED',
            error: {
              code: 'SSO_REAUTH_REQUIRED',
              message: 'SSO re-authentication is required for this workspace',
              redirectUrl,
            },
          },
          { status: 403 },
        ),
      ],
      acquire: async () => {
        throw new Error('device grant was cancelled');
      },
    });

    const raw = await platformWorkspaces(
      { action: 'switch', tenantId: 'target-tenant' },
      harness.ctx,
      dependencies.dependencies,
    );
    const result = parseResult(raw);

    expect(result).toMatchObject({
      success: false,
      errorCode: 'WORKSPACE_AUTHORIZATION_FAILED',
      activeWorkspace: 'source-tenant',
    });
    expect(dependencies.deviceCalls).toHaveLength(1);
    expect(dependencies.fetchCalls).toEqual([]);
    expect(raw).not.toContain(redirectUrl);
    expect(raw).not.toContain('attacker.example');
    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(dependencies.writtenCredentials).toEqual([]);
  });

  test.each([
    {
      name: 'another tenant',
      token: makeJwt({ sub: 'user-1', tenantId: 'other-tenant', role: 'OWNER' }),
    },
    {
      name: 'another user',
      token: makeJwt({ sub: 'intruder', tenantId: 'target-tenant', role: 'OWNER' }),
    },
    { name: 'an opaque token', token: 'opaque-target-token' },
  ])('rejects a device grant whose token identifies $name', async ({ token }) => {
    const harness = createWorkspaceContext();
    const dependencies = createDependencies({
      acquire: async () => ({
        accessToken: token,
        refreshToken: 'workspace-refresh',
        expiresIn: 3_600,
      }),
    });

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_WORKSPACE_RESPONSE' });
    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.sessionClear).not.toHaveBeenCalled();
    expect(harness.traceClear).not.toHaveBeenCalled();
    expect(dependencies.writtenCredentials).toEqual([]);
  });

  test.each([
    {
      name: 'zero expiry',
      credentials: { accessToken: TARGET_TOKEN, refreshToken: 'workspace-refresh', expiresIn: 0 },
    },
    {
      name: 'fractional expiry',
      credentials: { accessToken: TARGET_TOKEN, refreshToken: 'workspace-refresh', expiresIn: 1.5 },
    },
    {
      name: 'whitespace-padded tenant',
      credentials: {
        accessToken: makeJwt({
          sub: 'user-1',
          tenantId: ' target-tenant',
          role: 'ADMIN',
          exp: 9_999_999_999,
        }),
        refreshToken: 'workspace-refresh',
        expiresIn: 3_600,
      },
    },
    {
      name: 'oversized access token',
      credentials: {
        accessToken: 'x'.repeat(128 * 1024 + 1),
        refreshToken: 'workspace-refresh',
        expiresIn: 3_600,
      },
    },
  ])('rejects a device grant with $name', async ({ credentials }) => {
    const harness = createWorkspaceContext();
    const dependencies = createDependencies({
      acquire: async () => credentials,
    });

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_WORKSPACE_RESPONSE' });
    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(dependencies.writtenCredentials).toEqual([]);
  });

  test('restores the prior authenticated socket when the target handshake fails', async () => {
    const server = await createWebSocketServer((token) => token === SOURCE_TOKEN);
    const harness = createWorkspaceContext({ wsUrl: server.url });
    const dependencies = createDependencies();
    await harness.wsClient.connect();

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: 'WORKSPACE_CONNECTION_FAILED',
      activeWorkspace: 'source-tenant',
    });
    expect(server.attemptedTokens).toEqual([SOURCE_TOKEN, TARGET_TOKEN]);
    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.isConnected()).toBe(true);
    expect(harness.sessionClear).not.toHaveBeenCalled();
    expect(harness.traceClear).not.toHaveBeenCalled();
    expect(dependencies.writtenCredentials).toEqual([]);
  });

  test('aborts the candidate and leaves the old socket live when credential persistence fails', async () => {
    const server = await createWebSocketServer();
    const harness = createWorkspaceContext({ wsUrl: server.url });
    const dependencies = createDependencies({
      storedCredentials: sourceCredentials(),
      writeError: new Error('credential file is read-only'),
    });
    await harness.wsClient.connect();

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: 'WORKSPACE_CREDENTIAL_PERSISTENCE_FAILED',
      credentialPersisted: false,
      candidateAborted: true,
      activeWorkspace: 'source-tenant',
      activeTarget: { tenantId: 'source-tenant', subject: 'user-1' },
    });
    expect(String(result.error)).toContain('credential file is read-only');
    expect(server.attemptedTokens).toEqual([SOURCE_TOKEN, TARGET_TOKEN]);
    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.isConnected()).toBe(true);
    expect(harness.sessionClear).not.toHaveBeenCalled();
    expect(harness.traceClear).not.toHaveBeenCalled();
    expect(dependencies.writtenCredentials).toEqual([]);
  });

  test('rolls credentials back when the candidate closes during credential commit', async () => {
    const server = await createWebSocketServer();
    const harness = createWorkspaceContext({ wsUrl: server.url });
    const dependencies = createDependencies({
      storedCredentials: sourceCredentials(),
      onWrite: (credentials) => {
        if (credentials.token === TARGET_TOKEN) server.closeLatestConnection();
      },
      beforeWebSocketCommit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });
    await harness.wsClient.connect();

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: 'WORKSPACE_CONNECTION_FAILED',
      credentialRolledBack: true,
    });
    expect(dependencies.writtenCredentials.map((credentials) => credentials.token)).toEqual([
      TARGET_TOKEN,
      SOURCE_TOKEN,
    ]);
    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.wsClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.sessionClear).not.toHaveBeenCalled();
    expect(harness.traceClear).not.toHaveBeenCalled();
  });

  test('serializes current-context reads behind an in-flight workspace transition', async () => {
    const harness = createWorkspaceContext();
    const pendingGrant = deferred<AcquiredDeviceCredentials>();
    const dependencies = createDependencies({ acquire: async () => pendingGrant.promise });

    const switchPromise = platformWorkspaces(
      { action: 'switch', tenantId: 'target-tenant' },
      harness.ctx,
      dependencies.dependencies,
    );
    await waitFor(() => dependencies.deviceCalls.length === 1);

    let currentSettled = false;
    const currentPromise = platformWorkspaces(
      { action: 'current' },
      harness.ctx,
      dependencies.dependencies,
    ).then((value) => {
      currentSettled = true;
      return value;
    });
    await Promise.resolve();
    expect(currentSettled).toBe(false);

    pendingGrant.resolve({
      accessToken: TARGET_TOKEN,
      refreshToken: 'workspace-refresh',
      expiresIn: 3_600,
    });
    const [switched, current] = await Promise.all([switchPromise, currentPromise]);

    expect(parseResult(switched)).toMatchObject({ success: true, contextVersion: 1 });
    expect(parseResult(current)).toMatchObject({
      success: true,
      tenantId: 'target-tenant',
      contextVersion: 1,
      activeTarget: { tenantId: 'target-tenant', subject: 'user-1' },
    });
  });

  test('reports identity-aware active target metadata for list and current', async () => {
    const harness = createWorkspaceContext();
    const dependencies = createDependencies({
      fetchResponses: [
        jsonResponse({
          tenants: [
            { tenantId: 'source-tenant', tenantName: 'Source', role: 'OWNER' },
            { tenantId: 'target-tenant', tenantName: 'Target', role: 'ADMIN' },
          ],
        }),
      ],
    });

    const listed = parseResult(
      await platformWorkspaces({ action: 'list' }, harness.ctx, dependencies.dependencies),
    );
    const current = parseResult(
      await platformWorkspaces({ action: 'current' }, harness.ctx, dependencies.dependencies),
    );

    expect(listed).toMatchObject({
      success: true,
      activeWorkspace: 'source-tenant',
      activeTarget: {
        environment: 'development',
        tenantId: 'source-tenant',
        subject: 'user-1',
      },
    });
    expect(listed.workspaces).toEqual([
      { tenantId: 'source-tenant', tenantName: 'Source', role: 'OWNER', active: true },
      { tenantId: 'target-tenant', tenantName: 'Target', role: 'ADMIN' },
    ]);
    expect(current).toMatchObject({
      success: true,
      tenantId: 'source-tenant',
      userId: 'user-1',
      activeTarget: { tenantId: 'source-tenant', subject: 'user-1' },
    });
  });

  test('reports null optional context claims when an authenticated token omits them', async () => {
    const minimalToken = makeJwt({ userId: 'legacy-user' });
    const harness = createWorkspaceContext({ sourceToken: minimalToken });
    const dependencies = createDependencies({
      fetchResponses: [
        jsonResponse({
          tenants: [{ tenantId: 'tenant', tenantName: 'Tenant', role: 'MEMBER' }],
        }),
      ],
    });

    const listed = parseResult(
      await platformWorkspaces({ action: 'list' }, harness.ctx, dependencies.dependencies),
    );
    const current = parseResult(
      await platformWorkspaces({ action: 'current' }, harness.ctx, dependencies.dependencies),
    );

    expect(listed).toMatchObject({
      success: true,
      activeWorkspace: null,
      workspaces: [{ tenantId: 'tenant', tenantName: 'Tenant', role: 'MEMBER' }],
    });
    expect(current).toMatchObject({
      success: true,
      tenantId: null,
      role: null,
      userId: 'legacy-user',
      email: null,
      orgId: null,
      tokenExpiresAt: null,
    });
  });

  test('rejects oversized and over-cardinality workspace lists', async () => {
    const harness = createWorkspaceContext();
    const oversized = new Response('{}', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': '1100000' },
    });
    const dependencies = createDependencies({
      fetchResponses: [oversized, jsonResponse({ tenants: new Array(1_001).fill({}) })],
    });

    const oversizedResult = parseResult(
      await platformWorkspaces({ action: 'list' }, harness.ctx, dependencies.dependencies),
    );
    const cardinalityResult = parseResult(
      await platformWorkspaces({ action: 'list' }, harness.ctx, dependencies.dependencies),
    );

    expect(oversizedResult).toMatchObject({
      success: false,
      errorCode: 'INVALID_WORKSPACE_RESPONSE',
    });
    expect(cardinalityResult).toMatchObject({
      success: false,
      errorCode: 'INVALID_WORKSPACE_RESPONSE',
    });
  });

  test('fails closed for missing connection, authentication, target, and verifiable identity', async () => {
    const disconnected = createWorkspaceContext();
    disconnected.httpClient.setBaseUrl('');
    const unauthenticated = createWorkspaceContext();
    unauthenticated.httpClient.setAuthToken(null);
    const malformedIdentity = createWorkspaceContext({ sourceToken: 'not-a-jwt' });

    await expect(platformWorkspaces({ action: 'list' }, disconnected.ctx)).resolves.toContain(
      'Not connected',
    );
    await expect(platformWorkspaces({ action: 'list' }, unauthenticated.ctx)).resolves.toContain(
      'Not authenticated',
    );
    await expect(
      platformWorkspaces({ action: 'switch' }, createWorkspaceContext().ctx),
    ).resolves.toContain('tenantId is required');
    await expect(
      platformWorkspaces({ action: 'switch', tenantId: 'target-tenant' }, malformedIdentity.ctx),
    ).resolves.toContain('CURRENT_IDENTITY_UNVERIFIABLE');
    await expect(
      platformWorkspaces({ action: 'current' }, malformedIdentity.ctx),
    ).resolves.toContain('Could not decode auth token');
    await expect(
      platformWorkspaces({ action: 'unknown' } as never, createWorkspaceContext().ctx),
    ).resolves.toContain('Unknown action');
  });

  test('bounds list error bodies and reports transport failures without leaking response data', async () => {
    const harness = createWorkspaceContext();
    const dependencies = createDependencies({
      fetchResponses: [
        new Response('x'.repeat(65 * 1024), { status: 500 }),
        new Error('network unavailable'),
      ],
    });

    const boundedError = parseResult(
      await platformWorkspaces({ action: 'list' }, harness.ctx, dependencies.dependencies),
    );
    const transportError = parseResult(
      await platformWorkspaces({ action: 'list' }, harness.ctx, dependencies.dependencies),
    );

    expect(boundedError).toMatchObject({ success: false });
    expect(boundedError.hint).toBeUndefined();
    expect(JSON.stringify(boundedError)).not.toContain('x'.repeat(100));
    expect(transportError).toMatchObject({
      success: false,
      error: 'platform_workspaces list failed: network unavailable',
    });
  });

  test.each([
    null,
    [],
    {},
    { tenants: 'not-an-array' },
    { tenants: [null] },
    { tenants: [[]] },
    { tenants: [{ tenantId: '', tenantName: 'Name', role: 'OWNER' }] },
    { tenants: [{ tenantId: ' tenant ', tenantName: 'Name', role: 'OWNER' }] },
    { tenants: [{ tenantId: 'tenant', tenantName: '', role: 'OWNER' }] },
    { tenants: [{ tenantId: 'tenant', tenantName: 'Name', role: 'INVALID' }] },
    { tenants: [{ tenantId: 'tenant', tenantName: 'Name', role: 'OWNER', orgId: '' }] },
  ])('rejects malformed workspace list contract %#', async (body) => {
    const harness = createWorkspaceContext();
    const dependencies = createDependencies({ fetchResponses: [jsonResponse(body)] });

    const result = parseResult(
      await platformWorkspaces({ action: 'list' }, harness.ctx, dependencies.dependencies),
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: 'INVALID_WORKSPACE_RESPONSE',
    });
  });

  test('aborts a prepared candidate that becomes unready before credential commit', async () => {
    const harness = createWorkspaceContext();
    const abort = vi.fn();
    vi.spyOn(harness.wsClient, 'isConnected').mockReturnValue(true);
    vi.spyOn(harness.wsClient, 'prepareReplacement').mockResolvedValue({
      isReady: () => false,
      commit: vi.fn(),
      abort,
    });
    const dependencies = createDependencies();

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: 'WORKSPACE_CONNECTION_FAILED',
      candidateAborted: true,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(dependencies.writtenCredentials).toEqual([]);
  });

  test('retains the source context when the credential transaction lock cannot be acquired', async () => {
    const harness = createWorkspaceContext();
    const dependencies = createDependencies({
      lockError: new Error('credential lock busy'),
    });

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: 'WORKSPACE_CREDENTIAL_LOCK_FAILED',
      activeWorkspace: 'source-tenant',
    });
    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
  });

  test('refuses to overwrite credentials changed by another process during authorization', async () => {
    const harness = createWorkspaceContext();
    const newerCredentials = {
      ...sourceCredentials(),
      token: makeJwt({
        sub: 'user-1',
        tenantId: 'newer-tenant',
        role: 'OWNER',
        exp: 9_999_999_999,
      }),
    };
    const dependencies = createDependencies({
      storedCredentials: sourceCredentials(),
      readStoredCredentialsSequence: [sourceCredentials(), newerCredentials],
    });

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: 'WORKSPACE_CREDENTIAL_PERSISTENCE_FAILED',
      credentialPersisted: false,
    });
    expect(dependencies.writtenCredentials).toEqual([]);
  });

  test('reports a rollback failure without publishing the staged target context', async () => {
    const harness = createWorkspaceContext();
    const dependencies = createDependencies({
      storedCredentials: sourceCredentials(),
      beforeWebSocketCommit: async () => {
        throw new Error('promotion failed');
      },
      restoreError: new Error('rollback store unavailable'),
    });

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: 'WORKSPACE_CREDENTIAL_ROLLBACK_FAILED',
    });
    expect(harness.httpClient.getAuthToken()).toBe(SOURCE_TOKEN);
    expect(harness.sessionClear).not.toHaveBeenCalled();
    expect(harness.traceClear).not.toHaveBeenCalled();
  });

  test('preserves same-subject email while deriving expiry only from the target JWT', async () => {
    const targetWithoutMetadata = makeJwt({
      sub: 'user-1',
      tenantId: 'target-tenant',
      role: 'MEMBER',
      exp: 9_999_999_999,
    });
    const harness = createWorkspaceContext();
    const dependencies = createDependencies({
      storedCredentials: sourceCredentials(),
      acquire: async () => ({
        accessToken: targetWithoutMetadata,
        refreshToken: 'workspace-refresh',
        expiresIn: 3_600,
      }),
    });

    const result = parseResult(
      await platformWorkspaces(
        { action: 'switch', tenantId: 'target-tenant' },
        harness.ctx,
        dependencies.dependencies,
      ),
    );

    expect(result).toMatchObject({ success: true, tenantId: 'target-tenant' });
    expect(dependencies.writtenCredentials).toEqual([
      expect.objectContaining({
        token: targetWithoutMetadata,
        email: 'developer@example.com',
        expiresAt: new Date(9_999_999_999 * 1000).toISOString(),
      }),
    ]);
  });
});

function createWorkspaceContext(
  input: { serverUrl?: string; wsUrl?: string; sourceToken?: string } = {},
): WorkspaceContextHarness {
  const sourceToken = input.sourceToken ?? SOURCE_TOKEN;
  const httpClient = new HttpClient(input.serverUrl ?? SERVER_URL);
  const wsClient = new WebSocketClient({
    url: input.wsUrl ?? 'ws://127.0.0.1:1/ws',
    connectionTimeoutMs: 500,
  });
  const sessionStore = new SessionStore();
  const traceStore = new TraceStore();
  httpClient.setAuthToken(sourceToken);
  wsClient.setAuthToken(sourceToken);
  sessionStore.createSession('source-session', 'source-agent');
  clients.push(wsClient);

  const ctx: DebugContext = {
    httpClient,
    wsClient,
    sessionStore,
    traceStore,
    authenticate: async () => ({ token: sourceToken, method: 'explicit_token' }),
  };

  return {
    ctx,
    httpClient,
    wsClient,
    sessionClear: vi.spyOn(sessionStore, 'clear'),
    traceClear: vi.spyOn(traceStore, 'clear'),
  };
}

function createDependencies(
  input: {
    fetchResponses?: Array<Response | Error>;
    storedCredentials?: StoredCredentials | null;
    acquire?: (options: DeviceCredentialAcquisitionOptions) => Promise<AcquiredDeviceCredentials>;
    writeError?: Error;
    lockError?: Error;
    restoreError?: Error;
    readStoredCredentialsSequence?: StoredCredentials[];
    onWrite?: (credentials: StoredCredentials) => void;
    beforeWebSocketCommit?: () => Promise<void>;
  } = {},
): DependencyHarness {
  const fetchCalls: FetchCall[] = [];
  const deviceCalls: DeviceCredentialAcquisitionOptions[] = [];
  const writtenCredentials: StoredCredentials[] = [];
  let storedCredentials = input.storedCredentials ?? null;
  const storedCredentialReads = [...(input.readStoredCredentialsSequence ?? [])];
  const responseQueue = [...(input.fetchResponses ?? [])];

  const dependencies: PlatformWorkspaceDependencies = {
    fetchWithTimeout: async (url, options = {}, timeoutMs = 5000) => {
      fetchCalls.push({ url, options, timeoutMs });
      const next = responseQueue.shift();
      if (next instanceof Error) throw next;
      return next ?? jsonResponse({});
    },
    readStoredCredentials: () => storedCredentialReads.shift() ?? storedCredentials,
    readMcpStoredCredentials: () => storedCredentials,
    acquireStoredCredentialLock: async () => {
      if (input.lockError) throw input.lockError;
      return { release: () => undefined };
    },
    writeStoredCredentials: (credentials) => {
      if (input.writeError) throw input.writeError;
      writtenCredentials.push(credentials);
      storedCredentials = credentials;
      input.onWrite?.(credentials);
    },
    clearStoredCredentials: () => undefined,
    restoreStoredCredentials: (credentials) => {
      if (input.restoreError) throw input.restoreError;
      storedCredentials = credentials;
      if (credentials) writtenCredentials.push(credentials);
    },
    beforeWebSocketCommit: input.beforeWebSocketCommit,
    acquireDeviceCredentials: async (options) => {
      deviceCalls.push(options);
      if (input.acquire) return input.acquire(options);
      return {
        accessToken: TARGET_TOKEN,
        refreshToken: 'workspace-refresh',
        expiresIn: 3_600,
      };
    },
  };

  return { dependencies, fetchCalls, deviceCalls, writtenCredentials };
}

async function createWebSocketServer(
  acceptsToken: (token: string | null) => boolean | Promise<boolean> = () => true,
): Promise<WebSocketServerHarness> {
  const attemptedTokens: Array<string | null> = [];
  const connections: WebSocket[] = [];
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
  server.on('connection', (socket) => connections.push(socket));
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected WebSocketServer to listen on a TCP port');
  }

  const harness: WebSocketServerHarness = {
    url: `ws://127.0.0.1:${(address as AddressInfo).port}`,
    attemptedTokens,
    closeLatestConnection: () => connections.at(-1)?.terminate(),
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
  servers.push(harness);
  return harness;
}

function sourceCredentials(): StoredCredentials {
  return {
    token: SOURCE_TOKEN,
    refreshToken: 'source-refresh',
    expiresAt: '2099-01-01T00:00:00.000Z',
    email: 'developer@example.com',
    serverUrl: SERVER_URL,
  };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseResult(raw: string): Record<string, any> {
  return JSON.parse(raw) as Record<string, any>;
}

function makeJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Condition was not reached');
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

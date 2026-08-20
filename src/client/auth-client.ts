/**
 * Auth Client
 *
 * Implements the authentication cascade for Arch MCP tools:
 *   1. Explicit token (if provided)
 *   2. Stored credentials from the MCP-owned credential store
 *   3. Device authorization flow (RFC 8628)
 *      - Auto-launches browser
 *      - Polls in a single call (no two-phase handshake)
 *      - Persists credentials on success
 */

import type { HttpClient } from './http-client.js';
import type { WebSocketClient } from './websocket-client.js';
import {
  readStoredCredentials,
  clearStoredCredentials,
  hasValidToken,
  hasRefreshToken,
  writeStoredCredentials,
  restoreStoredCredentials,
  readMcpStoredCredentials,
  acquireStoredCredentialLock,
  storedCredentialIdentityMatches,
} from './credentials.js';
import type { StoredCredentialLock, StoredCredentials } from './credentials.js';
import { fetchWithTimeout } from '../utils/fetch.js';
import { execFile } from 'node:child_process';
import { ARCH_MCP_LOG_PREFIX } from '../tools/persona.js';
import { deriveStudioUrl } from '../utils/studio-api.js';
import {
  ResponseSizeLimitError,
  readBoundedResponseJson,
  readBoundedResponseText,
} from '../utils/bounded-response.js';

const MILLISECONDS_PER_SECOND = 1_000;
const DEFAULT_TOKEN_TTL_SECONDS = 86_400;
const MAX_DEVICE_CODE_LENGTH = 2_048;
const MAX_ACCESS_TOKEN_LENGTH = 128 * 1_024;
const MAX_REFRESH_TOKEN_LENGTH = 8 * 1_024;
const MAX_DEVICE_AUTH_EXPIRES_IN_SECONDS = 3_600;
const MAX_DEVICE_AUTH_INTERVAL_SECONDS = 60;
const MAX_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 31 * 24 * 60 * 60;
const MAX_AUTH_RESPONSE_BYTES = 512 * 1024;
const MAX_AUTH_ERROR_BYTES = 64 * 1024;
const MAX_TRANSIENT_DEVICE_POLL_BACKOFF_MS = 30_000;
const MAX_TRANSIENT_DEVICE_POLL_BACKOFF_EXPONENT = 4;

class StoredCredentialScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoredCredentialScopeError';
  }
}

class StoredCredentialStateError extends StoredCredentialScopeError {
  constructor(message: string) {
    super(message);
    this.name = 'StoredCredentialStateError';
  }
}

interface ResolvedAuthDependencies {
  readStoredCredentials: typeof readStoredCredentials;
  hasValidToken: typeof hasValidToken;
  hasRefreshToken: typeof hasRefreshToken;
  writeStoredCredentials: typeof writeStoredCredentials;
  restoreStoredCredentials: typeof restoreStoredCredentials;
  readMcpStoredCredentials: typeof readMcpStoredCredentials;
  acquireStoredCredentialLock: typeof acquireStoredCredentialLock;
  clearStoredCredentials: typeof clearStoredCredentials;
  fetchWithTimeout: typeof fetchWithTimeout;
  runCommand?: (command: string, args: string[], callback: (err: Error | null) => void) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

interface RefreshCredentialResult {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

const storedCredentialRefreshes = new Map<string, Promise<RefreshCredentialResult>>();

export type AuthDependencies = Partial<ResolvedAuthDependencies>;

export interface AuthResult {
  token: string;
  method: 'explicit_token' | 'stored_credentials' | 'device_auth' | 'device_auth_pending';
  message?: string;
  /** Present when method is 'device_auth_pending' — pass back to complete auth */
  deviceCode?: string;
  /** Verification URL for the user to visit */
  verificationUrl?: string;
  /** User-friendly code to display */
  userCode?: string;
  /**
   * Internal transition hook. When authentication is staged, call this only
   * after the authenticated transport succeeds and before committing clients.
   */
  commitCredentials?: () => void | (() => void);
  /** Acquire the global credential transaction lease before invoking commitCredentials. */
  acquireCredentialLock?: () => Promise<StoredCredentialLock>;
}

export interface AuthOptions {
  /** Explicit token to use directly */
  authToken?: string;
  /** Skip stored credentials check */
  skipStoredCredentials?: boolean;
  /** Device code from a previous initiation — skip straight to polling */
  deviceCode?: string;
  /** Max time to poll for device auth completion (default: 5 minutes) */
  pollTimeoutMs?: number;
  /** Stage the result without mutating clients or persisted credentials. */
  deferCommit?: boolean;
  /** Internal target override used by an atomic environment transition. */
  serverUrl?: string;
}

export interface DeviceCredentialAcquisitionOptions {
  serverUrl: string;
  purpose?: 'initial_login' | 'workspace_switch';
  requestedTenantId?: string;
  authorizationToken?: string;
  deviceCode?: string;
  pollTimeoutMs?: number;
}

export interface AcquiredDeviceCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  verificationUrl?: string;
  userCode?: string;
}

/** Set token on both HTTP and WS clients. */
function setTokenOnClients(httpClient: HttpClient, wsClient: WebSocketClient, token: string): void {
  httpClient.setAuthToken(token);
  wsClient.setAuthToken(token);
}

/**
 * Authenticate using the cascade:
 *   explicit token → stored credentials → device auth
 *
 * Sets the token on both HTTP and WS clients on success.
 */
export async function authenticate(
  httpClient: HttpClient,
  wsClient: WebSocketClient,
  options: AuthOptions = {},
  dependencies: AuthDependencies = {},
): Promise<AuthResult> {
  const baseUrl = options.serverUrl ?? httpClient.getBaseUrl();
  const resolvedDependencies: ResolvedAuthDependencies = {
    ...defaultAuthDependencies,
    ...dependencies,
  };

  // 1. Explicit token
  if (options.authToken) {
    if (!options.deferCommit) {
      setTokenOnClients(httpClient, wsClient, options.authToken);
    }
    return { token: options.authToken, method: 'explicit_token' };
  }

  // 2. Stored credentials
  if (!options.skipStoredCredentials) {
    const result = await tryStoredCredentials(
      httpClient,
      wsClient,
      baseUrl,
      resolvedDependencies,
      options.deferCommit ?? false,
    );
    if (result) return result;
  }

  // 3. Device auth — if deviceCode provided, poll for completion; otherwise full flow
  if (options.deviceCode) {
    const expectedCredentialState = resolvedDependencies.readStoredCredentials();
    const credentials = await acquireDeviceCredentials(
      {
        serverUrl: baseUrl,
        deviceCode: options.deviceCode,
        pollTimeoutMs: options.pollTimeoutMs,
      },
      resolvedDependencies,
    );
    return commitAcquiredDeviceCredentials(
      httpClient,
      wsClient,
      baseUrl,
      credentials,
      resolvedDependencies,
      options.deferCommit ?? false,
      expectedCredentialState,
    );
  }

  // Full device auth: initiate → open browser → poll → persist
  const expectedCredentialState = resolvedDependencies.readStoredCredentials();
  return await deviceAuthFlow(
    httpClient,
    wsClient,
    baseUrl,
    options.pollTimeoutMs,
    resolvedDependencies,
    options.deferCommit ?? false,
    expectedCredentialState,
  );
}

/**
 * Try to use stored credentials from the MCP-owned credential store.
 */
async function tryStoredCredentials(
  httpClient: HttpClient,
  wsClient: WebSocketClient,
  baseUrl: string,
  dependencies: ResolvedAuthDependencies,
  deferCommit: boolean,
): Promise<AuthResult | null> {
  try {
    const creds = dependencies.readStoredCredentials();
    if (!creds) return null;
    if (!creds.serverUrl) {
      console.error(
        `${ARCH_MCP_LOG_PREFIX} Legacy stored credentials have no server scope; device authorization is required`,
      );
      return null;
    }
    if (normalizeServerOrigin(creds.serverUrl) !== normalizeServerOrigin(baseUrl)) {
      console.error(`${ARCH_MCP_LOG_PREFIX} Stored credentials belong to a different server`);
      return null;
    }
    const storedScope = readTokenScope(creds.token);
    if (!storedScope) {
      console.error(
        `${ARCH_MCP_LOG_PREFIX} Stored credentials have no verifiable tenant and subject scope`,
      );
      return null;
    }

    // If token is still valid, use it directly
    if (dependencies.hasValidToken(creds)) {
      const validated = await validateStoredAccessToken(
        deriveStudioUrl(baseUrl),
        creds.token,
        dependencies,
      );
      if (!validated) return null;
      if (!deferCommit) {
        setTokenOnClients(httpClient, wsClient, creds.token);
      }
      console.error(`${ARCH_MCP_LOG_PREFIX} Using stored credentials`);
      return { token: creds.token, method: 'stored_credentials' };
    }

    // If expired but has refresh token, try to refresh
    if (dependencies.hasRefreshToken(creds) && creds.refreshToken) {
      try {
        const studioBaseUrl = deriveStudioUrl(baseUrl);
        const refreshResult = await refreshStoredCredentialsSingleFlight(
          studioBaseUrl,
          { ...creds, refreshToken: creds.refreshToken },
          storedScope,
          dependencies,
        );
        const persistenceOptions = {
          refreshToken: refreshResult.refreshToken,
          expiresIn: refreshResult.expiresIn,
          email: creds.email,
          serverUrl: baseUrl,
        };
        if (!deferCommit) {
          persistRefreshedCredentialsWithCas(
            creds,
            refreshResult.accessToken,
            persistenceOptions,
            dependencies,
          );
          setTokenOnClients(httpClient, wsClient, refreshResult.accessToken);
        }
        console.error(
          `${ARCH_MCP_LOG_PREFIX} ${deferCommit ? 'Staged refreshed credentials' : 'Refreshed stored credentials'}`,
        );
        return {
          token: refreshResult.accessToken,
          method: 'stored_credentials',
          ...(deferCommit
            ? {
                acquireCredentialLock: dependencies.acquireStoredCredentialLock,
                commitCredentials: () =>
                  persistRefreshedCredentialsWithCasAndRollback(
                    creds,
                    refreshResult.accessToken,
                    persistenceOptions,
                    dependencies,
                  ),
              }
            : {}),
        };
      } catch (err) {
        if (err instanceof StoredCredentialScopeError) {
          throw err;
        }
        console.error(
          `${ARCH_MCP_LOG_PREFIX} Token refresh failed:`,
          err instanceof Error ? err.message : String(err),
        );
        // Refresh failed, fall through to device auth
      }
    }
  } catch (err) {
    if (err instanceof StoredCredentialScopeError) {
      throw err;
    }
    console.error(
      `${ARCH_MCP_LOG_PREFIX} Credential reading failed:`,
      err instanceof Error ? err.message : String(err),
    );
    // Credential reading failed, fall through to device auth
  }

  return null;
}

async function validateStoredAccessToken(
  studioBaseUrl: string,
  token: string,
  dependencies: Pick<ResolvedAuthDependencies, 'fetchWithTimeout'>,
): Promise<boolean> {
  try {
    const response = await dependencies.fetchWithTimeout(
      `${studioBaseUrl}/api/auth/me`,
      { headers: { Authorization: `Bearer ${token}` } },
      10_000,
    );
    return response.ok;
  } catch (err) {
    console.error(
      `${ARCH_MCP_LOG_PREFIX} Stored credential validation failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Open a URL in the user's default browser.
 * Uses execFile (not exec) to avoid shell injection from server-provided URLs.
 * Best-effort — never throws.
 */
function openBrowser(
  url: string,
  dependencies: Pick<ResolvedAuthDependencies, 'runCommand'>,
): void {
  // Validate URL before launching to reject non-URL strings
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Unsupported browser URL protocol');
    }
  } catch (_err) {
    console.error(
      `${ARCH_MCP_LOG_PREFIX} Invalid verification URL, skipping browser launch: ${url}`,
    );
    return;
  }

  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  const callback = (err: Error | null) => {
    if (err) {
      console.error(`${ARCH_MCP_LOG_PREFIX} Could not open browser: ${err.message}`);
    }
  };

  try {
    if (dependencies.runCommand) {
      dependencies.runCommand(cmd, args, callback);
    } else {
      execFile(cmd, args, callback);
    }
  } catch (err) {
    console.error(
      `${ARCH_MCP_LOG_PREFIX} Browser launch failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Full device auth flow: initiate → open browser → poll → persist credentials.
 * Single call — no two-phase handshake needed.
 */
async function deviceAuthFlow(
  httpClient: HttpClient,
  wsClient: WebSocketClient,
  baseUrl: string,
  pollTimeoutMs?: number,
  dependencies: ResolvedAuthDependencies = defaultAuthDependencies,
  deferCommit = false,
  expectedCredentials: StoredCredentials | null = dependencies.readStoredCredentials(),
): Promise<AuthResult> {
  const credentials = await acquireDeviceCredentials(
    { serverUrl: baseUrl, pollTimeoutMs },
    dependencies,
  );
  const result = commitAcquiredDeviceCredentials(
    httpClient,
    wsClient,
    baseUrl,
    credentials,
    dependencies,
    deferCommit,
    expectedCredentials,
  );
  result.message = 'Authenticated via device authorization. Browser login successful.';
  return result;
}

/**
 * Acquire a device grant without mutating clients or persisted credentials.
 * Callers commit the returned credentials only after their transport transition succeeds.
 */
export async function acquireDeviceCredentials(
  options: DeviceCredentialAcquisitionOptions,
  dependencies: AuthDependencies = {},
): Promise<AcquiredDeviceCredentials> {
  const resolvedDependencies: ResolvedAuthDependencies = {
    ...defaultAuthDependencies,
    ...dependencies,
  };
  const studioBaseUrl = deriveStudioUrl(options.serverUrl);

  if (options.deviceCode) {
    const deviceCode = readBoundedString(options.deviceCode, MAX_DEVICE_CODE_LENGTH);
    if (!deviceCode) {
      throw new DeviceAuthError('Device authorization code is invalid.');
    }
    return pollDeviceCredentials(
      studioBaseUrl,
      deviceCode,
      options.pollTimeoutMs,
      resolvedDependencies,
    );
  }

  const requestBody: Record<string, unknown> = {
    scopes: ['read_traces', 'read_state', 'subscribe'],
  };
  if (options.purpose === 'workspace_switch') {
    if (!options.requestedTenantId || !options.authorizationToken) {
      throw new DeviceAuthError(
        'Workspace-switch device authorization requires a target workspace and current access token.',
      );
    }
    requestBody.purpose = 'workspace_switch';
    requestBody.requestedTenantId = options.requestedTenantId;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: new URL(studioBaseUrl).origin,
  };
  if (options.authorizationToken) {
    headers.Authorization = `Bearer ${options.authorizationToken}`;
  }

  const initResponse = await resolvedDependencies.fetchWithTimeout(
    `${studioBaseUrl}/api/auth/device`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    },
    15_000,
  );

  if (!initResponse.ok) {
    const errorText = await readResponseText(initResponse, 'Unknown error');
    throw new DeviceAuthError(
      `Failed to initiate device authorization (${initResponse.status}): ${errorText}. ` +
        `The connected Studio server may not have device authorization enabled.`,
    );
  }

  let initValue: unknown;
  try {
    initValue = await readBoundedResponseJson(initResponse, MAX_AUTH_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof ResponseSizeLimitError) {
      throw new DeviceAuthError(error.message);
    }
    throw new DeviceAuthError('Device authorization returned malformed JSON.');
  }
  const deviceAuth = parseDeviceAuthorizationResponse(initValue, studioBaseUrl);

  console.error(
    `${ARCH_MCP_LOG_PREFIX} Device auth initiated. Opening browser: ${deviceAuth.verification_uri_complete}`,
  );

  // 2. Auto-open browser
  openBrowser(deviceAuth.verification_uri_complete, resolvedDependencies);

  // 3. Poll for approval (blocks until approved or timeout)
  // Clamp server-provided expires_in to DEFAULT_POLL_TIMEOUT_MS to avoid unbounded waits
  const serverTimeoutMs = deviceAuth.expires_in * MILLISECONDS_PER_SECOND;
  const effectiveTimeout =
    options.pollTimeoutMs ?? Math.min(serverTimeoutMs, DEFAULT_POLL_TIMEOUT_MS);
  const credentials = await pollDeviceCredentials(
    studioBaseUrl,
    deviceAuth.device_code,
    effectiveTimeout,
    resolvedDependencies,
    Math.max(deviceAuth.interval * MILLISECONDS_PER_SECOND, MILLISECONDS_PER_SECOND),
  );
  return {
    ...credentials,
    verificationUrl: deviceAuth.verification_uri_complete,
    userCode: deviceAuth.user_code,
  };
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

function parseDeviceAuthorizationResponse(
  value: unknown,
  studioBaseUrl: string,
): DeviceAuthorizationResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeviceAuthError('Device authorization returned an invalid response.');
  }
  const record = value as Record<string, unknown>;
  const deviceCode = readBoundedString(record.device_code, MAX_DEVICE_CODE_LENGTH);
  const userCode = readBoundedString(record.user_code, 64);
  const verificationUri = readBoundedString(record.verification_uri, 2_048);
  const verificationUriComplete = readBoundedString(record.verification_uri_complete, 2_048);
  const expiresIn = readBoundedPositiveNumber(
    record.expires_in,
    MAX_DEVICE_AUTH_EXPIRES_IN_SECONDS,
  );
  const interval = readBoundedPositiveNumber(record.interval, MAX_DEVICE_AUTH_INTERVAL_SECONDS);
  if (
    !deviceCode ||
    !userCode ||
    !verificationUri ||
    !verificationUriComplete ||
    expiresIn === null ||
    interval === null ||
    !/^[A-Za-z0-9]{2,16}(?:-[A-Za-z0-9]{2,16}){0,3}$/.test(userCode)
  ) {
    throw new DeviceAuthError('Device authorization response fields are invalid.');
  }

  const expectedOrigin = new URL(studioBaseUrl).origin;
  let verification: URL;
  let complete: URL;
  try {
    verification = new URL(verificationUri);
    complete = new URL(verificationUriComplete);
  } catch (_error) {
    throw new DeviceAuthError('Device authorization returned an invalid verification URL.');
  }
  for (const candidate of [verification, complete]) {
    if (
      (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') ||
      candidate.origin !== expectedOrigin ||
      candidate.pathname !== '/auth/device' ||
      candidate.username ||
      candidate.password ||
      candidate.hash
    ) {
      throw new DeviceAuthError(
        'Device authorization verification URL does not match the connected Studio origin.',
      );
    }
  }
  if (
    verification.search.length > 0 ||
    Array.from(complete.searchParams.keys()).some((key) => key !== 'code') ||
    complete.searchParams.getAll('code').length !== 1 ||
    complete.searchParams.get('code') !== userCode
  ) {
    throw new DeviceAuthError('Device authorization verification URL contains an invalid code.');
  }

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verification.toString(),
    verification_uri_complete: complete.toString(),
    expires_in: expiresIn,
    interval,
  };
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : null;
}

function readBoundedPositiveNumber(value: unknown, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maximum
    ? value
    : null;
}

interface JwtMetadata {
  exp?: number;
  email?: string;
  tenantId?: string;
  sub?: string;
  userId?: string;
}

/** Decode JWT metadata without verifying the token. */
function decodeJwtPayload(token: string): JwtMetadata {
  try {
    if (token.length === 0 || token.length > MAX_ACCESS_TOKEN_LENGTH) return {};
    const payload = token.split('.')[1];
    if (!payload) return {};

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as unknown;
    return typeof decoded === 'object' && decoded !== null ? (decoded as JwtMetadata) : {};
  } catch (err) {
    console.error(
      `${ARCH_MCP_LOG_PREFIX} Could not decode token metadata:`,
      err instanceof Error ? err.message : String(err),
    );
    return {};
  }
}

function readTokenScope(token: string): { tenantId: string; subject: string } | null {
  const payload = decodeJwtPayload(token);
  const subject = payload.sub ?? payload.userId;
  return typeof payload.tenantId === 'string' &&
    payload.tenantId.trim().length > 0 &&
    typeof subject === 'string' &&
    subject.trim().length > 0
    ? { tenantId: payload.tenantId, subject }
    : null;
}

function resolveExpiresAt(payload: { exp?: number }, expiresIn?: number): string {
  if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
    return new Date(payload.exp * MILLISECONDS_PER_SECOND).toISOString();
  }

  const ttlSeconds =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn
      : DEFAULT_TOKEN_TTL_SECONDS;

  return new Date(Date.now() + ttlSeconds * MILLISECONDS_PER_SECOND).toISOString();
}

function credentialRefreshKey(
  origin: string,
  scope: { tenantId: string; subject: string },
  refreshToken: string,
): string {
  const refreshIdentity = Buffer.from(refreshToken, 'utf8').toString('base64url');
  return `${normalizeServerOrigin(origin)}\0${scope.subject}\0${scope.tenantId}\0${refreshIdentity}`;
}

async function refreshStoredCredentialsSingleFlight(
  studioBaseUrl: string,
  credentials: StoredCredentials & { refreshToken: string },
  storedScope: { tenantId: string; subject: string },
  dependencies: ResolvedAuthDependencies,
): Promise<RefreshCredentialResult> {
  const key = credentialRefreshKey(studioBaseUrl, storedScope, credentials.refreshToken);
  const existing = storedCredentialRefreshes.get(key);
  if (existing) return existing;

  const refresh = (async (): Promise<RefreshCredentialResult> => {
    try {
      const response = await dependencies.fetchWithTimeout(
        `${studioBaseUrl}/api/auth/refresh`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: new URL(studioBaseUrl).origin,
          },
          body: JSON.stringify({
            refresh_token: credentials.refreshToken,
            refreshToken: credentials.refreshToken,
            tenantId: storedScope.tenantId,
          }),
        },
        15_000,
      );
      if (!response.ok) {
        throw new Error(`Token refresh failed with status ${response.status}`);
      }
      const data = parseRefreshCredentialResponse(
        await readBoundedResponseJson(response, MAX_AUTH_RESPONSE_BYTES),
      );
      const refreshedScope = readTokenScope(data.accessToken);
      if (!refreshedScope) {
        throw new StoredCredentialScopeError(
          'Refreshed access token has no verifiable tenant and subject scope.',
        );
      }
      if (
        refreshedScope.tenantId !== storedScope.tenantId ||
        refreshedScope.subject !== storedScope.subject
      ) {
        throw new StoredCredentialScopeError(
          `Refreshed access token is scoped to tenant ${refreshedScope.tenantId} and does not match stored tenant ${storedScope.tenantId}.`,
        );
      }
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || data.refresh_token || credentials.refreshToken,
        expiresIn: data.expiresIn ?? data.expires_in,
      };
    } finally {
      storedCredentialRefreshes.delete(key);
    }
  })();
  storedCredentialRefreshes.set(key, refresh);
  return refresh;
}

interface CredentialIdentity {
  origin: string | null;
  subject: string | null;
  tenantId: string | null;
  token: string;
  refreshToken: string | null;
}

function readCredentialIdentity(credentials: StoredCredentials | null): CredentialIdentity | null {
  if (!credentials) return null;
  const scope = readTokenScope(credentials.token);
  return {
    origin: credentials.serverUrl ? normalizeServerOrigin(credentials.serverUrl) : null,
    subject: scope?.subject ?? null,
    tenantId: scope?.tenantId ?? null,
    token: credentials.token,
    refreshToken: credentials.refreshToken ?? null,
  };
}

function sameCredentialIdentity(
  left: StoredCredentials | null,
  right: StoredCredentials | null,
): boolean {
  return (
    JSON.stringify(readCredentialIdentity(left)) === JSON.stringify(readCredentialIdentity(right))
  );
}

function buildStoredCredentials(
  token: string,
  options: { refreshToken?: string; expiresIn?: number; email?: string; serverUrl?: string },
): StoredCredentials {
  const payload = decodeJwtPayload(token);
  return {
    token,
    ...(options.refreshToken !== undefined ? { refreshToken: options.refreshToken } : {}),
    expiresAt: resolveExpiresAt(payload, options.expiresIn),
    ...(options.email || payload.email ? { email: options.email || payload.email } : {}),
    ...(options.serverUrl ? { serverUrl: normalizeServerOrigin(options.serverUrl) } : {}),
  };
}

function assertCredentialCas(
  expected: StoredCredentials,
  desired: StoredCredentials,
  dependencies: Pick<ResolvedAuthDependencies, 'readStoredCredentials'>,
): 'write' | 'already_committed' {
  const current = dependencies.readStoredCredentials();
  if (sameCredentialIdentity(current, desired)) return 'already_committed';
  if (!sameCredentialIdentity(current, expected)) {
    throw new StoredCredentialStateError(
      'Stored credentials changed while token refresh was in progress; refusing to overwrite the active environment or workspace context.',
    );
  }
  return 'write';
}

function persistRefreshedCredentialsWithCas(
  expected: StoredCredentials,
  token: string,
  options: { refreshToken?: string; expiresIn?: number; email?: string; serverUrl?: string },
  dependencies: Pick<ResolvedAuthDependencies, 'readStoredCredentials' | 'writeStoredCredentials'>,
): { desired: StoredCredentials; wrote: boolean } {
  const desired = buildStoredCredentials(token, options);
  const outcome = assertCredentialCas(expected, desired, dependencies);
  if (outcome === 'write') {
    dependencies.writeStoredCredentials(desired);
  }
  return { desired, wrote: outcome === 'write' };
}

function persistRefreshedCredentialsWithCasAndRollback(
  expected: StoredCredentials,
  token: string,
  options: { refreshToken?: string; expiresIn?: number; email?: string; serverUrl?: string },
  dependencies: Pick<
    ResolvedAuthDependencies,
    'readStoredCredentials' | 'writeStoredCredentials' | 'restoreStoredCredentials'
  >,
): () => void {
  const { desired, wrote } = persistRefreshedCredentialsWithCas(
    expected,
    token,
    options,
    dependencies,
  );
  // A follower of the process-wide refresh flight may observe that another
  // transition already committed the same lineage. It does not own that write
  // and therefore must not roll it back if its own transport promotion fails.
  if (!wrote) return () => undefined;
  return () => {
    if (!sameCredentialIdentity(dependencies.readStoredCredentials(), desired)) {
      throw new StoredCredentialStateError(
        'Stored credentials changed after refresh commit; refusing to roll back a newer context.',
      );
    }
    dependencies.restoreStoredCredentials(expected);
  };
}

function persistCredentialsFromToken(
  token: string,
  options: { refreshToken?: string; expiresIn?: number; email?: string; serverUrl?: string } = {},
  dependencies: Pick<ResolvedAuthDependencies, 'writeStoredCredentials'> = defaultAuthDependencies,
): void {
  try {
    persistCredentialsFromTokenStrict(token, options, dependencies);
  } catch (err) {
    console.error(
      `${ARCH_MCP_LOG_PREFIX} Failed to persist credentials:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

function persistCredentialsFromTokenStrict(
  token: string,
  options: { refreshToken?: string; expiresIn?: number; email?: string; serverUrl?: string } = {},
  dependencies: Pick<ResolvedAuthDependencies, 'writeStoredCredentials'> = defaultAuthDependencies,
): void {
  dependencies.writeStoredCredentials(buildStoredCredentials(token, options));
  console.error(`${ARCH_MCP_LOG_PREFIX} Credentials saved to MCP-owned credential store`);
}

function persistCredentialsFromTokenWithRollback(
  token: string,
  options: { refreshToken?: string; expiresIn?: number; email?: string; serverUrl?: string },
  dependencies: Pick<
    ResolvedAuthDependencies,
    | 'readStoredCredentials'
    | 'readMcpStoredCredentials'
    | 'writeStoredCredentials'
    | 'restoreStoredCredentials'
  >,
  expected: StoredCredentials | null,
): () => void {
  const current = dependencies.readStoredCredentials();
  if (!storedCredentialIdentityMatches(current, expected)) {
    throw new StoredCredentialStateError(
      'Stored credentials changed while device authorization was in progress; refusing to overwrite the active environment or workspace context.',
    );
  }
  const snapshot = dependencies.readMcpStoredCredentials();
  persistCredentialsFromTokenStrict(token, options, dependencies);
  const desired = dependencies.readStoredCredentials();
  if (!desired || desired.token !== token) {
    throw new StoredCredentialStateError(
      'The committed device credentials could not be read back from the MCP credential store.',
    );
  }
  return () => {
    if (!storedCredentialIdentityMatches(dependencies.readStoredCredentials(), desired)) {
      throw new StoredCredentialStateError(
        'Stored credentials changed after device authorization commit; refusing to roll back a newer context.',
      );
    }
    dependencies.restoreStoredCredentials(snapshot);
  };
}

const DEFAULT_POLL_TIMEOUT_MS = 300_000; // 5 minutes — generous for login + approve

/**
 * Poll for device auth completion. Called on the second platform_connect call
 * after the user has (hopefully) approved in the browser.
 */
async function pollDeviceCredentials(
  studioBaseUrl: string,
  deviceCode: string,
  pollTimeoutMs?: number,
  dependencies: ResolvedAuthDependencies = defaultAuthDependencies,
  pollIntervalMs = 3_000,
): Promise<AcquiredDeviceCredentials> {
  const timeout = pollTimeoutMs || DEFAULT_POLL_TIMEOUT_MS;
  const expiresAt = dependencies.now() + timeout;
  let transientServerErrorCount = 0;

  while (dependencies.now() < expiresAt) {
    try {
      const tokenResponse = await dependencies.fetchWithTimeout(
        `${studioBaseUrl}/api/auth/device/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: new URL(studioBaseUrl).origin,
          },
          body: JSON.stringify({ device_code: deviceCode }),
        },
        15_000,
      );

      if (tokenResponse.ok) {
        let tokenValue: unknown;
        try {
          tokenValue = await readBoundedResponseJson(tokenResponse, MAX_AUTH_RESPONSE_BYTES);
        } catch (error) {
          if (error instanceof ResponseSizeLimitError) {
            throw new DeviceAuthError(error.message);
          }
          throw new DeviceAuthError('Device token endpoint returned malformed JSON.');
        }
        const tokenData = parseDeviceTokenResponse(tokenValue);

        return {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresIn: tokenData.expires_in,
        };
      }

      // Check error type
      const errorData = await readDeviceError(tokenResponse);

      // Runtime can return a retryable server_error after it has atomically
      // finalized a device exchange but cannot recover the encrypted replay
      // payload on that request. Ingresses may replace that response with any
      // bounded 5xx and an empty or HTML body. Keep polling the same one-time
      // device code; the grant deadline still bounds the loop, and the capped
      // exponential delay prevents a failing service from becoming a hot loop.
      if (tokenResponse.status >= 500 && tokenResponse.status <= 599) {
        transientServerErrorCount += 1;
        await dependencies.sleep(
          calculateTransientDevicePollBackoffMs(pollIntervalMs, transientServerErrorCount),
        );
        continue;
      }

      if (errorData.error === 'authorization_pending') {
        transientServerErrorCount = 0;
        await dependencies.sleep(pollIntervalMs);
        continue;
      }

      if (errorData.error === 'slow_down') {
        transientServerErrorCount = 0;
        await dependencies.sleep(pollIntervalMs * 2);
        continue;
      }

      if (errorData.error === 'expired_token') {
        throw new DeviceAuthError(
          'Device authorization expired. Please run platform_connect again to start a new flow.',
        );
      }

      throw new DeviceAuthError(
        `Device authorization failed: ${errorData.error || 'unknown error'}`,
      );
    } catch (e) {
      if (e instanceof DeviceAuthError) throw e;
      console.error(
        `${ARCH_MCP_LOG_PREFIX} Token polling error:`,
        e instanceof Error ? e.message : String(e),
      );
      await dependencies.sleep(pollIntervalMs);
      continue;
    }
  }

  throw new DeviceAuthError(
    'Device authorization not yet approved (timed out waiting). ' +
      'Run platform_connect again to start a new device authorization flow.',
  );
}

function calculateTransientDevicePollBackoffMs(
  baseIntervalMs: number,
  failureCount: number,
): number {
  const exponent = Math.min(Math.max(failureCount, 1), MAX_TRANSIENT_DEVICE_POLL_BACKOFF_EXPONENT);
  return Math.min(baseIntervalMs * 2 ** exponent, MAX_TRANSIENT_DEVICE_POLL_BACKOFF_MS);
}

function parseDeviceTokenResponse(value: unknown): {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeviceAuthError('Device token endpoint returned an invalid response.');
  }
  const record = value as Record<string, unknown>;
  const accessToken = readBoundedString(record.access_token, MAX_ACCESS_TOKEN_LENGTH);
  const expiresIn = readBoundedPositiveNumber(
    record.expires_in,
    MAX_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  );
  const refreshToken =
    record.refresh_token === undefined
      ? undefined
      : readBoundedString(record.refresh_token, MAX_REFRESH_TOKEN_LENGTH);
  if (
    !accessToken ||
    expiresIn === null ||
    (record.refresh_token !== undefined && !refreshToken) ||
    !readTokenScope(accessToken)
  ) {
    throw new DeviceAuthError(
      'Device token endpoint returned invalid token, expiry, or identity fields.',
    );
  }
  return {
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    expires_in: expiresIn,
  };
}

function parseRefreshCredentialResponse(value: unknown): {
  accessToken: string;
  refreshToken?: string;
  refresh_token?: string;
  expiresIn?: number;
  expires_in?: number;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Token refresh returned an invalid response.');
  }
  const record = value as Record<string, unknown>;
  const accessToken = readBoundedString(record.accessToken, MAX_ACCESS_TOKEN_LENGTH);
  const camelRefresh =
    record.refreshToken === undefined
      ? undefined
      : readBoundedString(record.refreshToken, MAX_REFRESH_TOKEN_LENGTH);
  const snakeRefresh =
    record.refresh_token === undefined
      ? undefined
      : readBoundedString(record.refresh_token, MAX_REFRESH_TOKEN_LENGTH);
  const rawExpiresIn = record.expiresIn ?? record.expires_in;
  const expiresIn =
    rawExpiresIn === undefined
      ? undefined
      : readBoundedPositiveNumber(rawExpiresIn, MAX_ACCESS_TOKEN_EXPIRES_IN_SECONDS);
  if (
    !accessToken ||
    expiresIn === null ||
    (record.refreshToken !== undefined && !camelRefresh) ||
    (record.refresh_token !== undefined && !snakeRefresh)
  ) {
    throw new Error('Token refresh returned invalid token or expiry fields.');
  }
  return {
    accessToken,
    ...(camelRefresh ? { refreshToken: camelRefresh } : {}),
    ...(snakeRefresh ? { refresh_token: snakeRefresh } : {}),
    ...(record.expiresIn !== undefined && expiresIn !== undefined ? { expiresIn } : {}),
    ...(record.expires_in !== undefined && expiresIn !== undefined
      ? { expires_in: expiresIn }
      : {}),
  };
}

async function readResponseText(response: Response, fallback: string): Promise<string> {
  try {
    return await readBoundedResponseText(response, MAX_AUTH_ERROR_BYTES);
  } catch (_error) {
    return fallback;
  }
}

async function readDeviceError(response: Response): Promise<{ error?: string }> {
  const body = await readResponseText(response, '');
  if (!body) return {};
  try {
    const value = JSON.parse(body) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const error = (value as Record<string, unknown>).error;
    return typeof error === 'string' ? { error } : {};
  } catch (_error) {
    return {};
  }
}

function commitAcquiredDeviceCredentials(
  httpClient: HttpClient,
  wsClient: WebSocketClient,
  serverUrl: string,
  credentials: AcquiredDeviceCredentials,
  dependencies: ResolvedAuthDependencies,
  deferCommit = false,
  expectedCredentials: StoredCredentials | null = dependencies.readStoredCredentials(),
): AuthResult {
  const persistenceOptions = {
    refreshToken: credentials.refreshToken,
    expiresIn: credentials.expiresIn,
    serverUrl,
  };
  if (!deferCommit) {
    setTokenOnClients(httpClient, wsClient, credentials.accessToken);
    persistCredentialsFromToken(credentials.accessToken, persistenceOptions, dependencies);
  }
  console.error(
    `${ARCH_MCP_LOG_PREFIX} ${deferCommit ? 'Staged device authorization credentials' : 'Authenticated via device authorization'}`,
  );
  return {
    token: credentials.accessToken,
    method: 'device_auth',
    ...(deferCommit
      ? {
          acquireCredentialLock: dependencies.acquireStoredCredentialLock,
          commitCredentials: () =>
            persistCredentialsFromTokenWithRollback(
              credentials.accessToken,
              persistenceOptions,
              dependencies,
              expectedCredentials,
            ),
        }
      : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeServerOrigin(value: string): string {
  try {
    return new URL(value).origin.toLowerCase();
  } catch (_err) {
    return value.replace(/\/+$/, '').toLowerCase();
  }
}

const defaultAuthDependencies: ResolvedAuthDependencies = {
  readStoredCredentials,
  hasValidToken,
  hasRefreshToken,
  writeStoredCredentials,
  restoreStoredCredentials,
  readMcpStoredCredentials,
  acquireStoredCredentialLock,
  clearStoredCredentials,
  fetchWithTimeout,
  sleep,
  now: Date.now,
};

export class DeviceAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceAuthError';
  }
}

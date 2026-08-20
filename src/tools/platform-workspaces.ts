/**
 * platform_workspaces Tool
 *
 * List, switch, and inspect workspaces (tenants) via the Studio REST API.
 *
 * Actions:
 *   list    — List all workspaces the authenticated user belongs to
 *   switch  — Switch to a different workspace (returns new scoped token)
 *   current — Show the currently active workspace (decoded from JWT)
 *
 * NOTE: Workspace endpoints live on the Studio API (port 5173), not the
 * runtime (port 3112). The HttpClient base URL typically points at the
 * runtime, so this tool rewrites the base URL to the Studio origin.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { buildStudioHeaders, deriveStudioUrl } from '../utils/studio-api.js';
import { fetchWithTimeout } from '../utils/fetch.js';
import {
  clearStoredCredentials,
  acquireStoredCredentialLock,
  readMcpStoredCredentials,
  readStoredCredentials,
  restoreStoredCredentials,
  storedCredentialIdentityMatches,
  writeStoredCredentials,
} from '../client/credentials.js';
import type { StoredCredentials } from '../client/credentials.js';
import { acquireDeviceCredentials, type AcquiredDeviceCredentials } from '../client/auth-client.js';
import {
  decodeJwtPayload,
  workspaceSwitchSuccessFromToken,
  type WorkspaceSwitchSuccess,
} from './workspace-switch-contract.js';
import {
  advanceContextVersion,
  getContextVersion,
  withContextTransition,
} from '../utils/context-transition.js';
import { describeActiveTarget, normalizeServerOrigin } from '../utils/platform-context.js';
import type { PreparedWebSocketReplacement } from '../client/websocket-client.js';
import {
  ResponseSizeLimitError,
  readBoundedResponseJson,
  readBoundedResponseText,
} from '../utils/bounded-response.js';

const MAX_WORKSPACE_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_WORKSPACE_COUNT = 1_000;
const MAX_WORKSPACE_NAME_LENGTH = 512;
const MAX_TENANT_ID_LENGTH = 256;
const MAX_ORGANIZATION_ID_LENGTH = 256;
const WORKSPACE_ROLE_VALUES = new Set(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER', 'CUSTOM']);

// =============================================================================
// SCHEMA
// =============================================================================

export const platformWorkspacesSchema = z.object({
  action: z.enum(['list', 'switch', 'current']),
  tenantId: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe('Tenant ID to switch to (required for switch)'),
});

type PlatformWorkspacesArgs = z.infer<typeof platformWorkspacesSchema>;

// =============================================================================
// HELPERS
// =============================================================================

function success(data: Record<string, unknown>): string {
  return JSON.stringify({ success: true, ...data }, null, 2);
}

function error(message: string, hint?: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ success: false, error: message, ...(hint ? { hint } : {}), ...extra });
}

function toRecord(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { data };
}

export interface PlatformWorkspaceDependencies {
  fetchWithTimeout: typeof fetchWithTimeout;
  readStoredCredentials: typeof readStoredCredentials;
  writeStoredCredentials: typeof writeStoredCredentials;
  clearStoredCredentials: typeof clearStoredCredentials;
  acquireStoredCredentialLock: typeof acquireStoredCredentialLock;
  readMcpStoredCredentials: typeof readMcpStoredCredentials;
  restoreStoredCredentials: typeof restoreStoredCredentials;
  acquireDeviceCredentials: typeof acquireDeviceCredentials;
  beforeWebSocketCommit?: () => Promise<void>;
}

const defaultDependencies: PlatformWorkspaceDependencies = {
  fetchWithTimeout,
  readStoredCredentials,
  writeStoredCredentials,
  clearStoredCredentials,
  acquireStoredCredentialLock,
  readMcpStoredCredentials,
  restoreStoredCredentials,
  acquireDeviceCredentials,
};

// =============================================================================
// HANDLER
// =============================================================================

export async function platformWorkspaces(
  args: PlatformWorkspacesArgs,
  ctx: DebugContext,
  dependencies: Partial<PlatformWorkspaceDependencies> = {},
): Promise<string> {
  const result = await withContextTransition(ctx, () =>
    platformWorkspacesUnlocked(args, ctx, dependencies),
  );
  return decorateWorkspaceResult(result, ctx);
}

function decorateWorkspaceResult(result: string, ctx: DebugContext): string {
  try {
    const parsed = JSON.parse(result) as unknown;
    const record = toRecord(parsed);
    return JSON.stringify({
      ...record,
      activeTarget: describeContextTarget(ctx),
      contextVersion: getContextVersion(ctx),
    });
  } catch (_error) {
    return JSON.stringify({
      success: false,
      error: 'Workspace operation returned an invalid result.',
      activeTarget: describeContextTarget(ctx),
      contextVersion: getContextVersion(ctx),
    });
  }
}

async function platformWorkspacesUnlocked(
  args: PlatformWorkspacesArgs,
  ctx: DebugContext,
  dependencies: Partial<PlatformWorkspaceDependencies>,
): Promise<string> {
  const { action, tenantId } = args;
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  const baseUrl = ctx.httpClient.getBaseUrl();

  if (!baseUrl) {
    return error(
      'Not connected. Call platform_connect first.',
      'Run platform_connect with your serverUrl to establish a connection.',
    );
  }

  const studioBase = deriveStudioUrl(baseUrl);
  const headers = buildStudioHeaders(ctx, studioBase);

  if (!headers['Authorization']) {
    return error(
      'Not authenticated. Call platform_connect first.',
      'Run platform_connect to authenticate before managing workspaces.',
    );
  }

  try {
    switch (action) {
      // ----- LIST WORKSPACES -----
      case 'list': {
        const response = await resolvedDependencies.fetchWithTimeout(
          `${studioBase}/api/auth/tenants`,
          { headers },
          10_000,
        );
        if (!response.ok) {
          const body = await readResponseText(response);
          return error(
            `GET /api/auth/tenants failed: ${response.status} ${response.statusText}`,
            body || undefined,
          );
        }
        const data = parseWorkspaceList(
          await readBoundedResponseJson(response, MAX_WORKSPACE_RESPONSE_BYTES),
        );
        if (!data) {
          return error('Workspace list returned an invalid or oversized contract.', undefined, {
            errorCode: 'INVALID_WORKSPACE_RESPONSE',
          });
        }

        // Enrich with "active" flag from current JWT
        const currentTenantId = getCurrentTenantId(ctx);
        if (currentTenantId && Array.isArray(data.tenants)) {
          for (const tenant of data.tenants) {
            if (
              tenant &&
              typeof tenant === 'object' &&
              (tenant as Record<string, unknown>).tenantId === currentTenantId
            ) {
              (tenant as Record<string, unknown>).active = true;
            }
          }
        }

        return success({
          workspaces: data.tenants,
          activeWorkspace: currentTenantId || null,
          activeTarget: describeContextTarget(ctx),
          contextVersion: getContextVersion(ctx),
          total: Array.isArray(data.tenants) ? data.tenants.length : 0,
        });
      }

      // ----- SWITCH WORKSPACE -----
      case 'switch': {
        if (!tenantId) {
          return error(
            'tenantId is required for the switch action.',
            'Use action="list" first to see available workspaces and their tenantIds.',
          );
        }

        const currentToken = ctx.httpClient.getAuthToken();
        const expectedCredentials = resolvedDependencies.readStoredCredentials();
        const currentPayload = currentToken ? decodeJwtPayload(currentToken) : null;
        const expectedSubject = readJwtSubject(currentPayload);
        if (!currentToken || !expectedSubject) {
          return error(
            'The current authentication token has no verifiable user subject.',
            'Reconnect with platform_connect before switching workspaces.',
            { errorCode: 'CURRENT_IDENTITY_UNVERIFIABLE' },
          );
        }

        // Runtime device refresh tokens are immutably bound to their issuing
        // tenant. Start the purpose-bound device grant directly instead of
        // calling the ordinary Studio switch route first: that route can persist
        // lastActiveTenantId before browser approval completes, leaving account
        // state on B while the MCP process and credentials remain on A after a
        // cancellation. The device flow performs the target membership/policy
        // check with deviceUserCode and returns an access+refresh pair that is
        // atomically committed below.
        let acquiredCredentials: AcquiredDeviceCredentials;
        try {
          acquiredCredentials = await resolvedDependencies.acquireDeviceCredentials({
            serverUrl: baseUrl,
            purpose: 'workspace_switch',
            requestedTenantId: tenantId,
            authorizationToken: currentToken,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return error(
            `Workspace authorization could not be completed: ${message}`,
            'The current workspace and debug context were retained. Retry the switch to start a new authorization flow.',
            {
              errorCode: 'WORKSPACE_AUTHORIZATION_FAILED',
              requestedWorkspace: tenantId,
              activeWorkspace: getCurrentTenantId(ctx),
            },
          );
        }

        if (!acquiredCredentials.refreshToken?.trim()) {
          return error(
            'Workspace authorization did not return a target-bound refresh credential.',
            'The current workspace and debug context were retained. Retry the switch to start a new authorization flow.',
            {
              errorCode: 'INVALID_WORKSPACE_RESPONSE',
              requestedWorkspace: tenantId,
              activeWorkspace: getCurrentTenantId(ctx),
            },
          );
        }

        const authorizedOutcome = workspaceSwitchSuccessFromToken({
          accessToken: acquiredCredentials.accessToken,
          requestedTenantId: tenantId,
          expectedSubject,
          expiresIn: acquiredCredentials.expiresIn,
        });
        if (authorizedOutcome.kind !== 'success') {
          return error(
            authorizedOutcome.message,
            'The authorization result was rejected and the current workspace was retained.',
            {
              errorCode:
                authorizedOutcome.kind === 'failure'
                  ? authorizedOutcome.code
                  : 'INVALID_WORKSPACE_RESPONSE',
              requestedWorkspace: tenantId,
              activeWorkspace: getCurrentTenantId(ctx),
            },
          );
        }

        return applyWorkspaceSwitch(
          authorizedOutcome,
          ctx,
          baseUrl,
          resolvedDependencies,
          { refreshToken: acquiredCredentials.refreshToken },
          expectedCredentials,
        );
      }

      // ----- CURRENT WORKSPACE -----
      case 'current': {
        const token = ctx.httpClient.getAuthToken();
        if (!token) {
          return error('No auth token available. Call platform_connect first.');
        }

        const payload = decodeJwtPayload(token);
        if (!payload) {
          return error('Could not decode auth token. It may be malformed.');
        }

        return success({
          serverUrl: normalizeServerOrigin(baseUrl),
          tenantId: payload.tenantId || null,
          role: payload.role || null,
          userId: payload.sub || payload.userId || null,
          email: payload.email || null,
          orgId: payload.orgId || null,
          tokenExpiresAt: payload.exp
            ? new Date((payload.exp as number) * 1000).toISOString()
            : null,
          activeTarget: describeContextTarget(ctx),
          contextVersion: getContextVersion(ctx),
        });
      }

      default:
        return error(`Unknown action: ${action}`);
    }
  } catch (err) {
    if (err instanceof ResponseSizeLimitError) {
      return error(err.message, undefined, { errorCode: 'INVALID_WORKSPACE_RESPONSE' });
    }
    const message = err instanceof Error ? err.message : String(err);
    return error(
      `platform_workspaces ${action} failed: ${message}`,
      'Workspace endpoints are served by the Studio API (port 5173). Ensure Studio is running.',
    );
  }
}

async function applyWorkspaceSwitch(
  data: WorkspaceSwitchSuccess,
  ctx: DebugContext,
  serverUrl: string,
  dependencies: PlatformWorkspaceDependencies,
  acquiredCredentials: { refreshToken: string },
  expectedCredentials: StoredCredentials | null = dependencies.readStoredCredentials(),
): Promise<string> {
  const wasWebSocketConnected = ctx.wsClient.isConnected();
  let preparedWebSocket: PreparedWebSocketReplacement | null = null;

  if (wasWebSocketConnected) {
    try {
      preparedWebSocket = await ctx.wsClient.prepareReplacement({ authToken: data.accessToken });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return error(
        `Workspace connection could not be established: ${message}`,
        'The prior workspace connection and debug context were retained. Retry the switch or reconnect explicitly.',
        {
          errorCode: 'WORKSPACE_CONNECTION_FAILED',
          requestedWorkspace: data.tenantId,
          activeWorkspace: getCurrentTenantId(ctx),
        },
      );
    }
  }

  if (preparedWebSocket && !preparedWebSocket.isReady()) {
    preparedWebSocket.abort();
    return error(
      'Workspace candidate connection closed before it could be committed.',
      'The prior workspace connection and debug context remain active. Retry the switch.',
      {
        errorCode: 'WORKSPACE_CONNECTION_FAILED',
        requestedWorkspace: data.tenantId,
        activeWorkspace: getCurrentTenantId(ctx),
        activeTarget: describeContextTarget(ctx),
        candidateAborted: true,
      },
    );
  }

  let credentialLock: Awaited<ReturnType<typeof acquireStoredCredentialLock>>;
  try {
    credentialLock = await dependencies.acquireStoredCredentialLock();
  } catch (err) {
    preparedWebSocket?.abort();
    const message = err instanceof Error ? err.message : String(err);
    return error(`Workspace credential transaction could not start: ${message}`, undefined, {
      errorCode: 'WORKSPACE_CREDENTIAL_LOCK_FAILED',
      requestedWorkspace: data.tenantId,
      activeWorkspace: getCurrentTenantId(ctx),
      candidateAborted: true,
    });
  }

  const credentialSnapshot = dependencies.readMcpStoredCredentials();
  let committedCredentials: StoredCredentials | null = null;
  try {
    if (
      !storedCredentialIdentityMatches(dependencies.readStoredCredentials(), expectedCredentials)
    ) {
      throw new Error(
        'Stored credentials changed while the workspace transition was in progress; refusing to overwrite a newer context.',
      );
    }
    persistSwitchedWorkspaceToken(
      data.accessToken,
      serverUrl,
      dependencies,
      acquiredCredentials.refreshToken,
    );
    committedCredentials = dependencies.readStoredCredentials();
  } catch (err) {
    preparedWebSocket?.abort();
    credentialLock.release();
    const message = err instanceof Error ? err.message : String(err);
    return error(
      `Workspace credentials could not be persisted: ${message}`,
      'The prior workspace, credentials, and debug context were retained. Resolve credential-store access and retry.',
      {
        errorCode: 'WORKSPACE_CREDENTIAL_PERSISTENCE_FAILED',
        requestedWorkspace: data.tenantId,
        activeWorkspace: getCurrentTenantId(ctx),
        activeTarget: describeContextTarget(ctx),
        credentialPersisted: false,
        candidateAborted: true,
      },
    );
  }

  // Concrete client/store setters are synchronous, non-failing in-memory
  // operations. Perform them only after the authenticated transport and the
  // atomic credential write have both succeeded.
  try {
    await dependencies.beforeWebSocketCommit?.();
    if (preparedWebSocket) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!wasWebSocketConnected) {
      ctx.wsClient.setAuthToken(data.accessToken);
    } else {
      preparedWebSocket?.commit();
    }
  } catch (err) {
    preparedWebSocket?.abort();
    try {
      if (
        !storedCredentialIdentityMatches(dependencies.readStoredCredentials(), committedCredentials)
      ) {
        throw new Error(
          'Stored credentials changed after workspace commit; refusing to roll back a newer context.',
        );
      }
      dependencies.restoreStoredCredentials(credentialSnapshot);
    } catch (rollbackError) {
      const message =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      return error(
        `Workspace connection promotion failed and credential rollback failed: ${message}`,
        undefined,
        {
          errorCode: 'WORKSPACE_CREDENTIAL_ROLLBACK_FAILED',
          requestedWorkspace: data.tenantId,
          activeWorkspace: getCurrentTenantId(ctx),
        },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return error(`Workspace connection could not be committed: ${message}`, undefined, {
      errorCode: 'WORKSPACE_CONNECTION_FAILED',
      requestedWorkspace: data.tenantId,
      activeWorkspace: getCurrentTenantId(ctx),
      credentialRolledBack: true,
    });
  } finally {
    credentialLock.release();
  }
  ctx.httpClient.setAuthToken(data.accessToken);
  ctx.sessionStore.clear();
  ctx.traceStore.clear();

  return success({
    status: 'switched',
    tenantId: data.tenantId,
    role: data.role,
    orgId: data.orgId || null,
    serverUrl: normalizeServerOrigin(serverUrl),
    activeTarget: describeContextTarget(ctx),
    contextVersion: advanceContextVersion(ctx),
    websocketReconnected: wasWebSocketConnected,
    contextReset: true,
    credentialPersisted: true,
    message: `Switched to workspace ${data.tenantId} (role: ${data.role}). All subsequent API calls are scoped to this workspace.`,
  });
}

function persistSwitchedWorkspaceToken(
  accessToken: string,
  serverUrl: string,
  dependencies: Pick<
    PlatformWorkspaceDependencies,
    'readStoredCredentials' | 'writeStoredCredentials'
  >,
  acquiredRefreshToken: string,
): void {
  const existing = dependencies.readStoredCredentials();
  const payload = decodeJwtPayload(accessToken);
  const normalizedServerUrl = normalizeServerOrigin(serverUrl);
  const canPreserveExistingMetadata =
    existing !== null &&
    existing.serverUrl !== undefined &&
    normalizeServerOrigin(existing.serverUrl) === normalizedServerUrl &&
    credentialsHaveSameSubject(existing.token, accessToken);
  const tokenEmail =
    typeof payload?.email === 'string' && payload.email.trim().length > 0
      ? payload.email
      : undefined;
  const tokenExpiry = payload?.exp;
  if (typeof tokenExpiry !== 'number' || !Number.isSafeInteger(tokenExpiry) || tokenExpiry <= 0) {
    throw new Error('The workspace token expiry is unavailable.');
  }
  const resolvedExpiresAt = new Date(tokenExpiry * 1000).toISOString();

  dependencies.writeStoredCredentials({
    token: accessToken,
    expiresAt: resolvedExpiresAt,
    refreshToken: acquiredRefreshToken,
    ...(tokenEmail
      ? { email: tokenEmail }
      : canPreserveExistingMetadata && existing.email
        ? { email: existing.email }
        : {}),
    serverUrl: normalizedServerUrl,
  });
}

function credentialsHaveSameSubject(leftToken: string, rightToken: string): boolean {
  const leftSubject = readJwtSubject(decodeJwtPayload(leftToken));
  const rightSubject = readJwtSubject(decodeJwtPayload(rightToken));
  return leftSubject !== null && leftSubject === rightSubject;
}

function readJwtSubject(payload: Record<string, unknown> | null): string | null {
  const value = payload?.sub ?? payload?.userId;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await readBoundedResponseText(response, MAX_ERROR_RESPONSE_BYTES);
  } catch (_error) {
    return '';
  }
}

function parseWorkspaceList(value: unknown): { tenants: Array<Record<string, unknown>> } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const tenants = (value as Record<string, unknown>).tenants;
  if (!Array.isArray(tenants) || tenants.length > MAX_WORKSPACE_COUNT) return null;

  const parsed: Array<Record<string, unknown>> = [];
  for (const tenant of tenants) {
    if (tenant === null || typeof tenant !== 'object' || Array.isArray(tenant)) return null;
    const record = tenant as Record<string, unknown>;
    const tenantId = readBoundedContractString(record.tenantId, MAX_TENANT_ID_LENGTH);
    const tenantName = readBoundedContractString(record.tenantName, MAX_WORKSPACE_NAME_LENGTH);
    const role = readBoundedContractString(record.role, 64);
    const orgId =
      record.orgId === undefined || record.orgId === null
        ? undefined
        : readBoundedContractString(record.orgId, MAX_ORGANIZATION_ID_LENGTH);
    if (
      !tenantId ||
      !tenantName ||
      !role ||
      !WORKSPACE_ROLE_VALUES.has(role) ||
      (record.orgId != null && !orgId)
    ) {
      return null;
    }
    parsed.push({ tenantId, tenantName, role, ...(orgId ? { orgId } : {}) });
  }
  return { tenants: parsed };
}

function readBoundedContractString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : null;
}

/**
 * Extract the current tenantId from the JWT on the HTTP client.
 */
function getCurrentTenantId(ctx: DebugContext): string | null {
  const token = ctx.httpClient.getAuthToken();
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  return (payload.tenantId as string) || null;
}

function describeContextTarget(ctx: DebugContext) {
  return describeActiveTarget(
    ctx.httpClient.getBaseUrl(),
    ctx.httpClient.getAuthToken(),
    ctx.wsClient.getUrl(),
  );
}

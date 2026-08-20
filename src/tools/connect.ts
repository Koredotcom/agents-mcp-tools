/**
 * platform_connect Tool
 *
 * Connect to the runtime server and start receiving traces.
 * Uses single serverUrl with automatic auth cascade.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { deriveUrls, isRemoteUrl } from '../utils/url.js';
import {
  advanceContextVersion,
  getContextVersion,
  withContextTransition,
} from '../utils/context-transition.js';
import { describeActiveTarget } from '../utils/platform-context.js';

export const connectSchema = z.object({
  serverUrl: z
    .string()
    .optional()
    .describe(
      'Runtime server URL. If the user has not specified an environment, ask which one to connect to before proceeding — ' +
        'production (https://agents.kore.ai), dev (https://agents-dev.kore.ai), staging (https://agents-staging.kore.ai), ' +
        'or qa (https://agents-qa.kore.ai). Falls back to the AGENTS_URL env var if not provided.',
    ),
  authToken: z
    .string()
    .optional()
    .describe(
      'JWT auth token. If not provided, authentication is automatic (stored credentials → device auth with browser launch).',
    ),
  deviceCode: z
    .string()
    .optional()
    .describe(
      'Deprecated. Device auth now auto-polls in a single call. Only needed if resuming a previously interrupted flow.',
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      'Force reconnection even if already connected. Use when the auth token has expired or you need to re-authenticate.',
    ),
  // Deprecated — kept for backward compatibility
  wsUrl: z
    .string()
    .optional()
    .describe('Deprecated: use serverUrl instead. Runtime WebSocket URL.'),
  httpUrl: z
    .string()
    .optional()
    .describe('Deprecated: use serverUrl instead. Runtime HTTP API URL.'),
});

export type ConnectArgs = z.infer<typeof connectSchema>;

const DO_NOT_RETRY_HINT = 'Do NOT try alternative approaches. Report this error to the user.';

function connectSuccess(data: Record<string, unknown>): string {
  return JSON.stringify({ success: true, ...data });
}

function connectError(error: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ success: false, error, hint: DO_NOT_RETRY_HINT, ...extra });
}

export async function connect(args: ConnectArgs, ctx: DebugContext): Promise<string> {
  return withContextTransition(ctx, () => connectUnlocked(args, ctx));
}

async function connectUnlocked(args: ConnectArgs, ctx: DebugContext): Promise<string> {
  const { serverUrl, wsUrl, httpUrl, authToken, deviceCode, force } = args;

  const activeConnectionTarget = readConnectionTarget(ctx);
  const activeIdentityTarget = describeContextTarget(ctx);
  const activeAuthToken = ctx.httpClient.getAuthToken();
  const requestedTarget = resolveRequestedTarget(args, activeConnectionTarget);
  const resolvedUrl = requestedTarget.serverUrl;
  const hasExplicitTarget = Boolean(serverUrl || wsUrl || httpUrl);
  const wasConnected = ctx.wsClient.isConnected();
  const targetChanged = hasExplicitTarget && !targetsEqual(activeConnectionTarget, requestedTarget);

  // No URL configured — ask the user which environment to use, then provide it.
  if (!resolvedUrl) {
    return connectError(
      'No server URL configured. Ask the user which environment to connect to, then pass it as the serverUrl ' +
        'parameter (or set the AGENTS_URL environment variable). Options: production=https://agents.kore.ai, ' +
        'dev=https://agents-dev.kore.ai, staging=https://agents-staging.kore.ai, qa=https://agents-qa.kore.ai.',
    );
  }

  if (!targetsShareEnvironment(requestedTarget)) {
    return connectError(
      'The requested HTTP and WebSocket URLs resolve to different environments. Use one canonical serverUrl, or provide a matching legacy httpUrl/wsUrl pair.',
      {
        errorCode: 'INVALID_TARGET_CONFIGURATION',
        activeTarget: describeContextTarget(ctx),
        requestedTarget,
      },
    );
  }

  if (wasConnected && targetChanged && !force) {
    return connectError(
      'A different environment was requested while a connection is active. Pass force=true to switch environments explicitly.',
      {
        errorCode: 'RECONNECT_REQUIRED',
        activeTarget: describeContextTarget(ctx),
        requestedTarget,
      },
    );
  }

  if (wasConnected && authToken && !force && !targetChanged) {
    try {
      await ctx.wsClient.reconnect({ authToken });
      ctx.httpClient.setAuthToken(authToken);
      ctx.sessionStore.clear();
      ctx.traceStore.clear();
      return connectSuccess({
        status: 'token_refreshed',
        serverUrl: activeConnectionTarget.serverUrl,
        wsUrl: activeConnectionTarget.wsUrl,
        activeTarget: describeContextTarget(ctx),
        contextVersion: advanceContextVersion(ctx),
        contextReset: true,
        message: 'Auth token and authenticated WebSocket connection were replaced.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return connectError(`Authenticated socket replacement failed: ${message}`, {
        errorCode: 'TOKEN_REFRESH_FAILED',
        activeTarget: describeContextTarget(ctx),
        contextVersion: getContextVersion(ctx),
      });
    }
  }

  if (wasConnected && !force) {
    return connectSuccess({
      status: 'already_connected',
      serverUrl: activeConnectionTarget.serverUrl,
      wsUrl: activeConnectionTarget.wsUrl,
      activeTarget: describeContextTarget(ctx),
      contextVersion: getContextVersion(ctx),
    });
  }

  const remote = isRemoteUrl(resolvedUrl);

  // For localhost: run health check first — fast feedback if server isn't running
  // For remote: skip health check — probe routes may not be routed through ingress,
  // and the WebSocket connection timeout (10s) handles unreachable servers
  if (!remote) {
    const health = await ctx.httpClient.runtimeHealthCheck(resolvedUrl);
    if (!health.reachable) {
      const reason = health.error ? ` (${health.error})` : '';
      return connectError(
        `Runtime not reachable at ${resolvedUrl}${reason}. Start the runtime server with: cd apps/runtime && pnpm dev`,
        {
          serverUrl: resolvedUrl,
          errorCode: health.errorCode,
          requestedTarget,
          activeTarget: describeContextTarget(ctx),
        },
      );
    }
  }

  // Authenticate using cascade (device auth now auto-opens browser and polls in one call)
  try {
    const authResult = await ctx.authenticate({
      authToken,
      deviceCode,
      deferCommit: true,
      serverUrl: resolvedUrl,
    });

    // Connect to WebSocket
    try {
      const preparedWebSocket = await ctx.wsClient.prepareReplacement({
        url: requestedTarget.wsUrl,
        authToken: authResult.token,
      });
      if (!preparedWebSocket.isReady()) {
        preparedWebSocket.abort();
        return connectError('Candidate WebSocket closed before it could be committed.', {
          errorCode: 'CANDIDATE_NOT_READY',
          requestedTarget,
          activeTarget: describeContextTarget(ctx),
          candidateAborted: true,
        });
      }

      let rollbackCredentials: (() => void) | undefined;
      let credentialLock:
        | Awaited<ReturnType<NonNullable<typeof authResult.acquireCredentialLock>>>
        | undefined;
      try {
        credentialLock = await authResult.acquireCredentialLock?.();
      } catch (error) {
        preparedWebSocket.abort();
        const message = error instanceof Error ? error.message : String(error);
        return connectError(`Credential transaction could not start: ${message}`, {
          errorCode: 'CREDENTIAL_LOCK_FAILED',
          requestedTarget,
          activeTarget: describeContextTarget(ctx),
          candidateAborted: true,
        });
      }
      try {
        const rollback = authResult.commitCredentials?.();
        rollbackCredentials = typeof rollback === 'function' ? rollback : undefined;
      } catch (error) {
        preparedWebSocket.abort();
        credentialLock?.release();
        const message = error instanceof Error ? error.message : String(error);
        return connectError(`Credential persistence failed: ${message}`, {
          errorCode: 'CREDENTIAL_PERSISTENCE_FAILED',
          requestedTarget,
          activeTarget: describeContextTarget(ctx),
          candidateAborted: true,
        });
      }

      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        preparedWebSocket.commit();
      } catch (error) {
        try {
          rollbackCredentials?.();
        } catch (rollbackError) {
          const rollbackMessage =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          return connectError(
            `WebSocket promotion failed and credential rollback failed: ${rollbackMessage}`,
            {
              errorCode: 'CREDENTIAL_ROLLBACK_FAILED',
              requestedTarget,
              activeTarget: describeContextTarget(ctx),
            },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return connectError(`Candidate WebSocket could not be committed: ${message}`, {
          errorCode: 'CANDIDATE_COMMIT_FAILED',
          requestedTarget,
          activeTarget: describeContextTarget(ctx),
          credentialRolledBack: Boolean(rollbackCredentials),
        });
      } finally {
        credentialLock?.release();
      }
      ctx.httpClient.setBaseUrl(resolvedUrl);
      ctx.httpClient.setAuthToken(authResult.token);

      const committedIdentityTarget = describeContextTarget(ctx);
      const identityChanged = !sameContextIdentity(
        activeIdentityTarget,
        committedIdentityTarget,
        activeAuthToken,
        authResult.token,
      );
      const contextReset = wasConnected || targetChanged || Boolean(force) || identityChanged;
      if (contextReset) {
        ctx.sessionStore.clear();
        ctx.traceStore.clear();
      }

      const connectedTarget = describeContextTarget(ctx);

      return connectSuccess({
        status: 'connected',
        serverUrl: resolvedUrl,
        wsUrl: ctx.wsClient.getUrl(),
        activeTarget: connectedTarget,
        contextVersion: advanceContextVersion(ctx),
        contextReset,
        authMethod: authResult.method,
        message: authResult.message || 'Connected to server. Ready to receive traces.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const errorCode = (error as { code?: string }).code;
      return connectError(`WebSocket connection failed: ${message}`, {
        serverUrl: resolvedUrl,
        wsUrl: requestedTarget.wsUrl,
        errorCode,
        requestedTarget,
        activeTarget: describeContextTarget(ctx),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const errorCode = (error as { code?: string }).code;
    return connectError(`Authentication failed: ${message}`, {
      serverUrl: resolvedUrl,
      errorCode,
      requestedTarget,
      activeTarget: describeContextTarget(ctx),
    });
  }
}

interface ConnectionTarget {
  serverUrl: string;
  wsUrl: string;
}

function readConnectionTarget(ctx: DebugContext): ConnectionTarget {
  return {
    serverUrl: ctx.httpClient.getBaseUrl(),
    wsUrl: ctx.wsClient.getUrl(),
  };
}

function resolveRequestedTarget(args: ConnectArgs, active: ConnectionTarget): ConnectionTarget {
  if (args.serverUrl) {
    const derived = deriveUrls(args.serverUrl);
    return { serverUrl: derived.httpUrl, wsUrl: derived.wsUrl };
  }
  return {
    serverUrl: args.httpUrl ?? active.serverUrl,
    wsUrl: args.wsUrl ?? active.wsUrl,
  };
}

function targetsEqual(left: ConnectionTarget, right: ConnectionTarget): boolean {
  return (
    normalizeTargetUrl(left.serverUrl) === normalizeTargetUrl(right.serverUrl) &&
    normalizeTargetUrl(left.wsUrl) === normalizeTargetUrl(right.wsUrl)
  );
}

function normalizeTargetUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch (_error) {
    return value.replace(/\/+$/, '').toLowerCase();
  }
}

function targetsShareEnvironment(target: ConnectionTarget): boolean {
  try {
    const http = new URL(target.serverUrl);
    const websocket = new URL(target.wsUrl);
    if (
      !['http:', 'https:'].includes(http.protocol) ||
      !['ws:', 'wss:'].includes(websocket.protocol)
    ) {
      return false;
    }
    const httpLocal = isLocalHostname(http.hostname);
    const websocketLocal = isLocalHostname(websocket.hostname);
    // Legacy split ports remain supported only when both endpoints are local.
    if (httpLocal || websocketLocal) return httpLocal && websocketLocal;
    const websocketHttpProtocol = websocket.protocol === 'wss:' ? 'https:' : 'http:';
    return http.origin === `${websocketHttpProtocol}//${websocket.host}`;
  } catch (_error) {
    return false;
  }
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function describeContextTarget(ctx: DebugContext) {
  return describeActiveTarget(
    ctx.httpClient.getBaseUrl(),
    ctx.httpClient.getAuthToken(),
    ctx.wsClient.getUrl(),
  );
}

function sameContextIdentity(
  before: ReturnType<typeof describeContextTarget>,
  after: ReturnType<typeof describeContextTarget>,
  previousToken: string | null,
  committedToken: string,
): boolean {
  if (
    before.serverUrl !== after.serverUrl ||
    before.tenantId !== after.tenantId ||
    before.subject !== after.subject
  ) {
    return false;
  }

  // If either token has no identity claims, equality cannot be inferred from
  // null metadata. Only an unchanged raw token is safe to treat as the same
  // context; the token never leaves this comparison or response boundary.
  return before.tenantId !== null && before.subject !== null
    ? true
    : previousToken === committedToken;
}

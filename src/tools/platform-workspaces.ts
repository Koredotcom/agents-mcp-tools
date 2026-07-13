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

import { z } from "zod";
import type { DebugContext } from "./index.js";
import { buildStudioHeaders, deriveStudioUrl } from "../utils/studio-api.js";
import { fetchWithTimeout } from "../utils/fetch.js";
import {
  readStoredCredentials,
  writeStoredCredentials,
} from "../client/credentials.js";

// =============================================================================
// SCHEMA
// =============================================================================

export const platformWorkspacesSchema = z.object({
  action: z.enum(["list", "switch", "current"]),
  tenantId: z
    .string()
    .optional()
    .describe("Tenant ID to switch to (required for switch)"),
});

type PlatformWorkspacesArgs = z.infer<typeof platformWorkspacesSchema>;

// =============================================================================
// HELPERS
// =============================================================================

function success(data: unknown): string {
  return JSON.stringify({ success: true, ...toRecord(data) }, null, 2);
}

function error(message: string, hint?: string): string {
  return JSON.stringify({
    success: false,
    error: message,
    ...(hint ? { hint } : {}),
  });
}

function toRecord(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { data };
}

/**
 * Decode the payload section of a JWT without verification.
 * Returns null if the token is malformed.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// =============================================================================
// HANDLER
// =============================================================================

export async function platformWorkspaces(
  args: PlatformWorkspacesArgs,
  ctx: DebugContext,
): Promise<string> {
  const { action, tenantId } = args;
  const baseUrl = ctx.httpClient.getBaseUrl();

  if (!baseUrl) {
    return error(
      "Not connected. Call platform_connect first.",
      "Run platform_connect with your serverUrl to establish a connection.",
    );
  }

  const studioBase = deriveStudioUrl(baseUrl);
  const headers = buildStudioHeaders(ctx, studioBase);

  if (!headers["Authorization"]) {
    return error(
      "Not authenticated. Call platform_connect first.",
      "Run platform_connect to authenticate before managing workspaces.",
    );
  }

  try {
    switch (action) {
      // ----- LIST WORKSPACES -----
      case "list": {
        const response = await fetchWithTimeout(
          `${studioBase}/api/auth/tenants`,
          { headers },
          10_000,
        );
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          return error(
            `GET /api/auth/tenants failed: ${response.status} ${response.statusText}`,
            body || undefined,
          );
        }
        const data = (await response.json()) as { tenants: unknown[] };

        // Enrich with "active" flag from current JWT
        const currentTenantId = getCurrentTenantId(ctx);
        if (currentTenantId && Array.isArray(data.tenants)) {
          for (const tenant of data.tenants) {
            if (
              tenant &&
              typeof tenant === "object" &&
              (tenant as Record<string, unknown>).tenantId === currentTenantId
            ) {
              (tenant as Record<string, unknown>).active = true;
            }
          }
        }

        return success({
          workspaces: data.tenants,
          activeWorkspace: currentTenantId || null,
          total: Array.isArray(data.tenants) ? data.tenants.length : 0,
        });
      }

      // ----- SWITCH WORKSPACE -----
      case "switch": {
        if (!tenantId) {
          return error(
            "tenantId is required for the switch action.",
            'Use action="list" first to see available workspaces and their tenantIds.',
          );
        }

        const response = await fetchWithTimeout(
          `${studioBase}/api/auth/tenants/switch`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ tenantId }),
          },
          15_000,
        );

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          if (response.status === 403) {
            return error(
              `Not a member of workspace ${tenantId}.`,
              'Use action="list" to see workspaces you have access to.',
            );
          }
          return error(
            `POST /api/auth/tenants/switch failed: ${response.status} ${response.statusText}`,
            body || undefined,
          );
        }

        const result = (await response.json()) as {
          accessToken: string;
          tenantId: string;
          role: string;
          expiresIn?: number;
          orgId?: string | null;
        };

        const wasWebSocketConnected = ctx.wsClient.isConnected();

        // HTTP requests read the current token per call, while WebSocket auth is
        // fixed during the handshake. Reconnect an open socket so subsequent
        // debug events and session subscriptions use the selected workspace.
        ctx.httpClient.setAuthToken(result.accessToken);
        ctx.wsClient.setAuthToken(result.accessToken);
        persistSwitchedWorkspaceToken(result.accessToken, result.expiresIn);
        if (wasWebSocketConnected) {
          ctx.wsClient.disconnect();
          await ctx.wsClient.connect();
        }

        return success({
          status: "switched",
          tenantId: result.tenantId,
          role: result.role,
          orgId: result.orgId || null,
          websocketReconnected: wasWebSocketConnected,
          message: `Switched to workspace ${result.tenantId} (role: ${result.role}). All subsequent API calls are scoped to this workspace.`,
        });
      }

      // ----- CURRENT WORKSPACE -----
      case "current": {
        const token = ctx.httpClient.getAuthToken();
        if (!token) {
          return error("No auth token available. Call platform_connect first.");
        }

        const payload = decodeJwtPayload(token);
        if (!payload) {
          return error("Could not decode auth token. It may be malformed.");
        }

        return success({
          tenantId: payload.tenantId || null,
          role: payload.role || null,
          userId: payload.sub || payload.userId || null,
          email: payload.email || null,
          orgId: payload.orgId || null,
          tokenExpiresAt: payload.exp
            ? new Date((payload.exp as number) * 1000).toISOString()
            : null,
        });
      }

      default:
        return error(`Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(
      `platform_workspaces ${action} failed: ${message}`,
      "Workspace endpoints are served by the Studio API (port 5173). Ensure Studio is running.",
    );
  }
}

function persistSwitchedWorkspaceToken(
  accessToken: string,
  expiresIn?: number,
): void {
  const existing = readStoredCredentials();
  const payload = decodeJwtPayload(accessToken);
  const jwtExpiry =
    typeof payload?.exp === "number" ? payload.exp * 1000 : null;
  const expiresAt =
    typeof expiresIn === "number" && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : jwtExpiry
        ? new Date(jwtExpiry).toISOString()
        : existing?.expiresAt;

  if (!expiresAt) return;

  writeStoredCredentials({
    token: accessToken,
    expiresAt,
    ...(existing?.refreshToken ? { refreshToken: existing.refreshToken } : {}),
    ...(existing?.email ? { email: existing.email } : {}),
  });
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

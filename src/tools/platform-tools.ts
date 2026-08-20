/**
 * platform_tools Tool
 *
 * Manage project tools (list, get, create, update, delete, test).
 *
 * NOTE: Tool CRUD endpoints live on the Studio API. Remote deployments
 * co-host Studio behind the same origin as runtime; local dev rewrites
 * the runtime port to the Studio port.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { buildStudioHeaders, deriveStudioUrl } from '../utils/studio-api.js';
import { fetchWithTimeout } from '../utils/fetch.js';
import { validatePathParam } from '../utils/validate.js';
import { findSensitiveFieldPath, sanitizeResponse } from '../utils/sanitize.js';

// =============================================================================
// SCHEMA
// =============================================================================

const MAX_LIST_LIMIT = 200;

export const platformToolsSchema = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'delete', 'test']),
  projectId: z.string().describe('Project ID'),
  page: z.number().int().min(1).optional().describe('Page number for list (starts at 1)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_LIMIT)
    .optional()
    .describe(`Tools per page for list (maximum ${MAX_LIST_LIMIT})`),
  toolId: z.string().optional().describe('Tool ID (for get, update, delete, test)'),
  input: z
    .record(z.unknown())
    .optional()
    .describe('Input object for tool execution (for test); string values are passed unchanged'),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .optional()
    .describe('Tool test timeout in milliseconds (for test)'),
  name: z.string().optional().describe('Tool name (for create)'),
  type: z
    .string()
    .optional()
    .describe('Tool type (for create: http, sandbox, mcp, workflow, integration, searchai, table)'),
  definition: z
    .record(z.unknown())
    .optional()
    .describe('Tool definition object (for create, update)'),
  confirm: z
    .boolean()
    .optional()
    .describe('Set to true to confirm destructive operations (delete)'),
  force: z
    .boolean()
    .optional()
    .describe(
      'Delete the tool even when agents or workflows still reference it (delete). ' +
        'Without this the API returns 409 listing the consumers.',
    ),
});

export type PlatformToolsArgs = z.infer<typeof platformToolsSchema>;

export interface PlatformToolsDependencies {
  fetchWithTimeout: typeof fetchWithTimeout;
}

const defaultPlatformToolsDependencies: PlatformToolsDependencies = {
  fetchWithTimeout,
};

// =============================================================================
// HELPERS
// =============================================================================

function success(data: unknown): string {
  return JSON.stringify({ success: true, data: sanitizeResponse(data) });
}

function error(message: string, hint?: string): string {
  return JSON.stringify(
    sanitizeResponse({ success: false, error: message, ...(hint ? { hint } : {}) }),
  );
}

// =============================================================================
// HANDLER
// =============================================================================

export async function platformTools(
  args: PlatformToolsArgs,
  ctx: DebugContext,
  dependencies: PlatformToolsDependencies = defaultPlatformToolsDependencies,
): Promise<string> {
  const {
    action,
    projectId,
    page,
    limit,
    toolId,
    input,
    timeoutMs,
    name,
    type,
    definition,
    confirm,
    force,
  } = args;
  const studioUrl = deriveStudioUrl(ctx.httpClient.getBaseUrl());
  const headers = buildStudioHeaders(ctx, studioUrl);
  const safeProjectId = validatePathParam(projectId, 'projectId');
  const basePath = `${studioUrl}/api/projects/${safeProjectId}/tools`;
  const fetchOperation = dependencies.fetchWithTimeout;

  try {
    switch (action) {
      // ----- LIST -----
      case 'list': {
        const searchParams = new URLSearchParams();
        if (page !== undefined) searchParams.set('page', String(page));
        if (limit !== undefined) searchParams.set('limit', String(limit));
        const query = searchParams.toString();
        const url = query ? `${basePath}?${query}` : basePath;
        const response = await fetchOperation(url, { headers }, 10_000);
        if (!response.ok) {
          return error(`GET ${url} failed: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return success(data);
      }

      // ----- GET -----
      case 'get': {
        if (!toolId) {
          return error('toolId is required for the "get" action.');
        }
        const safeToolId = validatePathParam(toolId, 'toolId');
        const url = `${basePath}/${safeToolId}`;
        const response = await fetchOperation(url, { headers }, 10_000);
        if (!response.ok) {
          return error(`GET ${url} failed: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return success(data);
      }

      // ----- CREATE -----
      case 'create': {
        const unsafePath = findSensitiveFieldPath({ name, type, definition });
        if (unsafePath) {
          return error(`Raw credential field "${unsafePath}" is not allowed in MCP arguments.`);
        }
        const body: Record<string, unknown> = { ...definition };
        if (name) body.name = name;
        if (type) body.toolType = type;

        const response = await fetchOperation(
          basePath,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          },
          10_000,
        );
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return error(`POST ${basePath} failed: ${response.status} ${response.statusText}`, text);
        }
        const data = await response.json();
        return success(data);
      }

      // ----- UPDATE -----
      case 'update': {
        if (!toolId) {
          return error('toolId is required for the "update" action.');
        }
        const safeToolId = validatePathParam(toolId, 'toolId');
        const unsafePath = findSensitiveFieldPath({ name, definition });
        if (unsafePath) {
          return error(`Raw credential field "${unsafePath}" is not allowed in MCP arguments.`);
        }
        const url = `${basePath}/${safeToolId}`;
        const body: Record<string, unknown> = { ...definition };
        if (name) body.name = name;

        const response = await fetchOperation(
          url,
          {
            method: 'PUT',
            headers,
            body: JSON.stringify(body),
          },
          10_000,
        );
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return error(`PUT ${url} failed: ${response.status} ${response.statusText}`, text);
        }
        const data = await response.json();
        return success(data);
      }

      // ----- DELETE -----
      case 'delete': {
        if (!toolId) {
          return error('toolId is required for the "delete" action.');
        }
        if (confirm !== true) {
          return JSON.stringify({
            success: false,
            needsConfirmation: true,
            message: 'This will permanently delete the tool. Set confirm: true to proceed.',
          });
        }
        const safeToolId = validatePathParam(toolId, 'toolId');
        // ABLP-3265: the API 409s when agents or workflow nodes still reference
        // the tool. Surface that body so the caller sees the consumers instead
        // of a bare status line, and only bypass it on an explicit `force`.
        const url = `${basePath}/${safeToolId}${force === true ? '?force=true' : ''}`;
        const response = await fetchOperation(
          url,
          {
            method: 'DELETE',
            headers,
          },
          10_000,
        );
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return error(`DELETE ${url} failed: ${response.status} ${response.statusText}`, text);
        }
        return success({ deleted: true, toolId });
      }

      // ----- TEST -----
      case 'test': {
        if (!toolId) {
          return error('toolId is required for the "test" action.');
        }
        const safeToolId = validatePathParam(toolId, 'toolId');
        const url = `${basePath}/${safeToolId}/test`;
        const response = await fetchOperation(
          url,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              ...(input !== undefined ? { input } : {}),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            }),
          },
          timeoutMs ?? 15_000,
        );
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return error(`POST ${url} failed: ${response.status} ${response.statusText}`, text);
        }
        const data = await response.json();
        return success(data);
      }

      default:
        return error(`Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(
      `Tool management request failed: ${message}`,
      'Tool CRUD endpoints are served by Studio. For local runtime URLs, ensure Studio is running on http://localhost:5173. For remote URLs, Arch uses the connected origin.',
    );
  }
}

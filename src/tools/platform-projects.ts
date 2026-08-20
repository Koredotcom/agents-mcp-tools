/**
 * platform_projects Tool
 *
 * Manage projects via the Studio REST API.
 * Supports list, get, create, update, and delete actions.
 *
 * NOTE: Project CRUD endpoints live on the Studio API (port 5173), not the
 * runtime (port 3112).  The HttpClient base URL typically points at the
 * runtime, so this tool rewrites the base URL to the Studio origin when
 * making requests.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { buildStudioHeaders, deriveStudioUrl } from '../utils/studio-api.js';
import { fetchWithTimeout } from '../utils/fetch.js';
import { validatePathParam } from '../utils/validate.js';
import { sanitizeResponse } from '../utils/sanitize.js';

// =============================================================================
// SCHEMA
// =============================================================================

export const platformProjectsSchema = z.object({
  action: z.enum(['list', 'get', 'create', 'delete', 'update']),
  projectId: z.string().optional().describe('Project ID (required for get, delete, update)'),
  name: z.string().optional().describe('Project name (required for create, optional for update)'),
  description: z.string().optional().describe('Project description (for create, update)'),
  entryAgentName: z
    .string()
    .nullable()
    .optional()
    .describe('Entry agent name (for update, set to null to clear)'),
  confirm: z
    .boolean()
    .optional()
    .describe('Set to true to confirm destructive operations (delete)'),
});

type PlatformProjectsArgs = z.infer<typeof platformProjectsSchema>;

// =============================================================================
// HELPERS
// =============================================================================

function success(data: unknown): string {
  return JSON.stringify(sanitizeResponse(data), null, 2);
}

function error(message: string, hint?: string): string {
  return JSON.stringify({ success: false, error: message, ...(hint ? { hint } : {}) });
}

// =============================================================================
// HANDLER
// =============================================================================

export async function platformProjects(
  args: PlatformProjectsArgs,
  ctx: DebugContext,
): Promise<string> {
  const { action, projectId, name, description, entryAgentName, confirm } = args;
  const studioBase = deriveStudioUrl(ctx.httpClient.getBaseUrl());
  const headers = buildStudioHeaders(ctx, studioBase);
  const basePath = `${studioBase}/api/projects`;

  try {
    switch (action) {
      case 'list': {
        const response = await fetchWithTimeout(basePath, { headers }, 10_000);
        if (!response.ok) {
          return error(`GET /api/projects failed: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return success(data);
      }

      case 'get': {
        if (!projectId) {
          return error('projectId is required for the get action.');
        }
        const safeProjectId = validatePathParam(projectId, 'projectId');
        const response = await fetchWithTimeout(
          `${basePath}/${safeProjectId}`,
          { headers },
          10_000,
        );
        if (!response.ok) {
          return error(
            `GET /api/projects/${safeProjectId} failed: ${response.status} ${response.statusText}`,
          );
        }
        const data = await response.json();
        return success(data);
      }

      case 'create': {
        if (!name) {
          return error('name is required for the create action.');
        }
        const body: Record<string, string> = { name };
        if (description) {
          body.description = description;
        }
        const response = await fetchWithTimeout(
          basePath,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          },
          10_000,
        );
        if (!response.ok) {
          return error(`POST /api/projects failed: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return success(data);
      }

      case 'delete': {
        if (!projectId) {
          return error('projectId is required for the delete action.');
        }
        if (confirm !== true) {
          return JSON.stringify({
            success: false,
            needsConfirmation: true,
            message:
              'This will permanently delete the project and all its resources. Set confirm: true to proceed.',
          });
        }
        const safeProjectId = validatePathParam(projectId, 'projectId');
        const response = await fetchWithTimeout(
          `${basePath}/${safeProjectId}`,
          {
            method: 'DELETE',
            headers,
          },
          10_000,
        );
        if (!response.ok) {
          return error(
            `DELETE /api/projects/${safeProjectId} failed: ${response.status} ${response.statusText}`,
          );
        }
        const data = await response.json().catch(() => ({}));
        return success(data);
      }

      case 'update': {
        if (!projectId) {
          return error('projectId is required for the update action.');
        }
        const safeProjectId = validatePathParam(projectId, 'projectId');
        const body: Record<string, unknown> = {};
        if (name !== undefined) {
          body.name = name;
        }
        if (description !== undefined) {
          body.description = description;
        }
        if (entryAgentName !== undefined) {
          body.entryAgentName = entryAgentName;
        }
        if (Object.keys(body).length === 0) {
          return error(
            'At least one field (name, description, entryAgentName) is required for the update action.',
          );
        }
        const response = await fetchWithTimeout(
          `${basePath}/${safeProjectId}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify(body),
          },
          10_000,
        );
        if (!response.ok) {
          return error(
            `PATCH /api/projects/${safeProjectId} failed: ${response.status} ${response.statusText}`,
          );
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
      `platform_projects ${action} failed: ${message}`,
      'Project CRUD endpoints are served by the Studio API (port 5173). Ensure Studio is running: cd apps/studio && pnpm dev',
    );
  }
}

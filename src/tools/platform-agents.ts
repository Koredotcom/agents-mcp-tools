/**
 * platform_agents Tool
 *
 * Manage agents within a project via the Runtime REST API.
 * Supports list, get, and save_dsl actions.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { validatePathParam } from '../utils/validate.js';
import { findSensitiveFieldPath, sanitizeResponse } from '../utils/sanitize.js';

// =============================================================================
// SCHEMA
// =============================================================================

export const platformAgentsSchema = z.object({
  action: z.enum(['list', 'get', 'save_dsl']),
  projectId: z.string().describe('Project ID'),
  agentName: z.string().optional().describe('Agent name (required for get, save_dsl)'),
  dslContent: z.string().optional().describe('DSL content (required for save_dsl)'),
});

type PlatformAgentsArgs = z.infer<typeof platformAgentsSchema>;

function success(data: unknown): string {
  return JSON.stringify(sanitizeResponse({ success: true, data }), null, 2);
}

function failure(error: string, hint?: string): string {
  return JSON.stringify(sanitizeResponse({ success: false, error, ...(hint ? { hint } : {}) }));
}

// =============================================================================
// HANDLER
// =============================================================================

export async function platformAgents(args: PlatformAgentsArgs, ctx: DebugContext): Promise<string> {
  const unsafePath = findSensitiveFieldPath(args);
  if (unsafePath) {
    return failure(`Raw credential field "${unsafePath}" is not allowed in MCP arguments.`);
  }
  const { action, projectId, agentName, dslContent } = args;
  const safeProjectId = validatePathParam(projectId, 'projectId');

  try {
    switch (action) {
      case 'list': {
        const result = await ctx.httpClient.get(`/api/projects/${safeProjectId}/agents`);
        return success(result);
      }

      case 'get': {
        if (!agentName) {
          return failure('agentName is required for the get action.');
        }
        const safeAgentName = validatePathParam(agentName, 'agentName');
        const result = await ctx.httpClient.get(
          `/api/projects/${safeProjectId}/agents/${safeAgentName}`,
        );
        return success(result);
      }

      case 'save_dsl': {
        if (!agentName) {
          return failure('agentName is required for the save_dsl action.');
        }
        if (!dslContent) {
          return failure('dslContent is required for the save_dsl action.');
        }
        const safeAgentName = validatePathParam(agentName, 'agentName');
        const result = await ctx.httpClient.put(
          `/api/projects/${safeProjectId}/agents/${safeAgentName}/dsl`,
          { dslContent },
        );
        return success(result);
      }

      default:
        return failure(`Unknown action: ${action}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      `platform_agents ${action} failed: ${message}`,
      'Ensure the runtime is running and you are connected (platform_connect).',
    );
  }
}

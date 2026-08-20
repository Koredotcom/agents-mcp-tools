/**
 * platform_workflows Tool
 *
 * Manage node-based workflows via the Studio REST API (which proxies workflow
 * CRUD to the runtime service). Supports the full end-to-end lifecycle:
 * list, get, create (from a canvas of nodes/edges), publish (a version),
 * execute, and delete.
 *
 * NOTE: Workflow endpoints live on the Studio API (port 5173); the Studio
 * layer proxies create/update/delete/execute to the runtime (port 3112). The
 * HttpClient base URL typically points at the runtime, so this tool rewrites
 * the base URL to the Studio origin (mirroring platform_projects).
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { buildStudioHeaders, deriveStudioUrl, readResponseBody } from '../utils/studio-api.js';
import { fetchWithTimeout } from '../utils/fetch.js';
import { validatePathParam } from '../utils/validate.js';
import { findSensitiveFieldPath, sanitizeResponse } from '../utils/sanitize.js';

const WORKFLOW_READ_TIMEOUT_MS = 10_000;
const WORKFLOW_MUTATION_TIMEOUT_MS = 15_000;
const WORKFLOW_EXECUTION_TIMEOUT_MS = 30_000;
const WORKFLOW_TOOL_MIN_TIMEOUT_MS = 1_000;
const WORKFLOW_TOOL_MAX_TIMEOUT_MS = 600_000;

// =============================================================================
// SCHEMA
// =============================================================================

const workflowNodeSchema = z.object({
  id: z.string().min(1),
  nodeType: z
    .string()
    .min(1)
    .describe(
      'Node type: start, end, function, condition, loop, delay, integration, human, data_entry, agent, tool, api',
    ),
  name: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.record(z.unknown()).optional(),
});

const workflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z
    .string()
    .optional()
    .describe(
      'Output handle on the source node. start/function/agent/tool/integration/api/delay/data_entry use "on_success" (+ "on_failure" when config.onFailureEnabled); human uses "on_approve"/"on_reject"; condition uses each condition id + "else"; loop uses "on_complete"/"on_failure". Omit to auto-normalize.',
    ),
  target: z.string().min(1),
  label: z.string().optional(),
});

const workflowParamMappingValueSchema = z
  .string()
  .regex(/^\$\./, 'Workflow parameter mappings must be JSONPath selectors such as "$.summary"');

export const platformWorkflowsSchema = z.object({
  action: z.enum([
    'list',
    'get',
    'create',
    'update',
    'publish',
    'execute',
    'create_tool',
    'delete',
  ]),
  projectId: z.string().min(1).describe('Project ID (required for every action)'),
  workflowId: z
    .string()
    .optional()
    .describe('Workflow ID (required for get, publish, execute, delete)'),
  name: z.string().optional().describe('Workflow name (required for create; 1-30 chars)'),
  workflowType: z
    .enum(['cx_automation', 'ex_automation', 'internal'])
    .optional()
    .describe('Workflow type for create (defaults to cx_automation)'),
  description: z.string().optional().describe('Workflow description (create)'),
  nodes: z.array(workflowNodeSchema).optional().describe('Canvas node definitions (create)'),
  edges: z.array(workflowEdgeSchema).optional().describe('Canvas edge connections (create)'),
  input: z.record(z.unknown()).optional().describe('Execution input payload (execute)'),
  changelog: z.string().optional().describe('Changelog note (publish)'),
  toolName: z.string().min(2).optional().describe('Project tool name (create_tool)'),
  toolDescription: z.string().optional().describe('Project tool description (create_tool)'),
  toolMode: z.enum(['sync', 'async']).optional().describe('Workflow tool invocation mode'),
  timeoutMs: z
    .number()
    .int()
    .min(WORKFLOW_TOOL_MIN_TIMEOUT_MS)
    .max(WORKFLOW_TOOL_MAX_TIMEOUT_MS)
    .optional(),
  paramMapping: z.record(workflowParamMappingValueSchema).optional(),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum workflows to list'),
  offset: z.number().int().nonnegative().optional().describe('Workflow list offset'),
  confirm: z
    .boolean()
    .optional()
    .describe('Set to true to confirm destructive operations (delete)'),
});

export type PlatformWorkflowsArgs = z.infer<typeof platformWorkflowsSchema>;

export interface PlatformWorkflowsDependencies {
  fetchWithTimeout: typeof fetchWithTimeout;
}

const defaultPlatformWorkflowsDependencies: PlatformWorkflowsDependencies = {
  fetchWithTimeout,
};

// =============================================================================
// HELPERS
// =============================================================================

function success(data: unknown): string {
  return JSON.stringify(sanitizeResponse(data), null, 2);
}

function error(message: string, hint?: string): string {
  return JSON.stringify(
    sanitizeResponse({ success: false, error: message, ...(hint ? { hint } : {}) }),
  );
}

async function readError(response: Response, method: string, path: string): Promise<string> {
  // Sanitize the upstream body before returning it — an error response can echo a
  // request payload, connector/auth config, or stack trace with a token/PII, and this
  // string is surfaced to the MCP client (an LLM/agent context). Mirrors the sanitized
  // structured-error shape used by requestStudioJson/formatStudioFailure in studio-api.
  const body = sanitizeResponse(await readResponseBody(response));
  return JSON.stringify(
    sanitizeResponse({
      success: false,
      error: `${method} ${path} failed: ${response.status} ${response.statusText}`,
      status: response.status,
      statusText: response.statusText,
      body,
    }),
  );
}

// =============================================================================
// HANDLER
// =============================================================================

export async function platformWorkflows(
  args: PlatformWorkflowsArgs,
  ctx: DebugContext,
  dependencies: PlatformWorkflowsDependencies = defaultPlatformWorkflowsDependencies,
): Promise<string> {
  const unsafePath = findSensitiveFieldPath(args);
  if (unsafePath) {
    return error(`Raw credential field "${unsafePath}" is not allowed in MCP arguments.`);
  }
  const { action, projectId, workflowId, name, workflowType, description, nodes, edges, input } =
    args;
  const studioBase = deriveStudioUrl(ctx.httpClient.getBaseUrl());
  const headers = buildStudioHeaders(ctx, studioBase);
  const safeProjectId = validatePathParam(projectId, 'projectId');
  const basePath = `${studioBase}/api/projects/${safeProjectId}/workflows`;
  const fetchOperation = dependencies.fetchWithTimeout;

  try {
    switch (action) {
      case 'list': {
        const query = new URLSearchParams();
        if (args.limit !== undefined) query.set('limit', String(args.limit));
        if (args.offset !== undefined) query.set('offset', String(args.offset));
        const path = query.size > 0 ? `${basePath}?${query}` : basePath;
        const response = await fetchOperation(path, { headers }, WORKFLOW_READ_TIMEOUT_MS);
        if (!response.ok) {
          return readError(response, 'GET', path);
        }
        return success(await response.json());
      }

      case 'get': {
        if (!workflowId) {
          return error('workflowId is required for the get action.');
        }
        const safeWorkflowId = validatePathParam(workflowId, 'workflowId');
        const path = `${basePath}/${safeWorkflowId}`;
        const response = await fetchOperation(path, { headers }, WORKFLOW_READ_TIMEOUT_MS);
        if (!response.ok) {
          return readError(response, 'GET', path);
        }
        return success(await response.json());
      }

      case 'create': {
        if (!name) {
          return error('name is required for the create action.');
        }
        if (!nodes || nodes.length === 0) {
          return error('nodes are required for the create action (at least a start and end node).');
        }
        const body: Record<string, unknown> = {
          name,
          type: workflowType ?? 'cx_automation',
          nodes,
          ...(edges ? { edges } : {}),
          ...(description ? { description } : {}),
        };
        const response = await fetchOperation(
          basePath,
          { method: 'POST', headers, body: JSON.stringify(body) },
          WORKFLOW_MUTATION_TIMEOUT_MS,
        );
        if (!response.ok) {
          return readError(response, 'POST', basePath);
        }
        return success(await response.json());
      }

      case 'update': {
        if (!workflowId) {
          return error('workflowId is required for the update action.');
        }
        const safeWorkflowId = validatePathParam(workflowId, 'workflowId');
        const path = `${basePath}/${safeWorkflowId}`;
        const body: Record<string, unknown> = {
          ...(name ? { name } : {}),
          ...(workflowType ? { type: workflowType } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(nodes ? { nodes } : {}),
          ...(edges ? { edges } : {}),
        };
        if (Object.keys(body).length === 0) {
          return error('At least one field is required for the update action.');
        }
        const response = await fetchOperation(
          path,
          { method: 'PATCH', headers, body: JSON.stringify(body) },
          WORKFLOW_MUTATION_TIMEOUT_MS,
        );
        if (!response.ok) {
          return readError(response, 'PATCH', path);
        }
        return success(await response.json());
      }

      case 'publish': {
        if (!workflowId) {
          return error('workflowId is required for the publish action.');
        }
        const safeWorkflowId = validatePathParam(workflowId, 'workflowId');
        const path = `${basePath}/${safeWorkflowId}/versions/publish`;
        const response = await fetchOperation(
          path,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(args.changelog ? { changelog: args.changelog } : {}),
          },
          WORKFLOW_MUTATION_TIMEOUT_MS,
        );
        if (!response.ok) {
          return readError(response, 'POST', path);
        }
        return success(await response.json());
      }

      case 'execute': {
        if (!workflowId) {
          return error('workflowId is required for the execute action.');
        }
        const safeWorkflowId = validatePathParam(workflowId, 'workflowId');
        const path = `${basePath}/${safeWorkflowId}/execute`;
        const response = await fetchOperation(
          path,
          { method: 'POST', headers, body: JSON.stringify({ input: input ?? {} }) },
          WORKFLOW_EXECUTION_TIMEOUT_MS,
        );
        if (!response.ok) {
          return readError(response, 'POST', path);
        }
        return success(await response.json());
      }

      case 'create_tool': {
        if (!workflowId) {
          return error('workflowId is required for the create_tool action.');
        }
        if (!args.toolName) {
          return error('toolName is required for the create_tool action.');
        }
        const safeWorkflowId = validatePathParam(workflowId, 'workflowId');
        const toolsPath = `${studioBase}/api/projects/${safeProjectId}/tools`;
        const response = await fetchOperation(
          toolsPath,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              name: args.toolName,
              description:
                args.toolDescription ?? `Invoke workflow ${safeWorkflowId} from an agent`,
              toolType: 'workflow',
              workflowId: safeWorkflowId,
              mode: args.toolMode ?? 'async',
              ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
              ...(args.paramMapping ? { paramMapping: args.paramMapping } : {}),
            }),
          },
          WORKFLOW_MUTATION_TIMEOUT_MS,
        );
        if (!response.ok) {
          return readError(response, 'POST', toolsPath);
        }
        const created = sanitizeResponse(await response.json());
        return JSON.stringify(
          {
            success: true,
            data: created,
            nextActions: [
              'Test the created workflow ProjectTool with platform_tools(action: "test").',
              'Read the target agent with platform_agents(action: "get"), add the returned tool DSL signature to its TOOLS section, then save the complete DSL with platform_agents(action: "save_dsl").',
              'Call platform_versions(action: "create") to compile and verify the new binding before deployment.',
            ],
          },
          null,
          2,
        );
      }

      case 'delete': {
        if (!workflowId) {
          return error('workflowId is required for the delete action.');
        }
        if (args.confirm !== true) {
          return JSON.stringify({
            success: false,
            needsConfirmation: true,
            message: 'This will delete the workflow. Set confirm: true to proceed.',
          });
        }
        const safeWorkflowId = validatePathParam(workflowId, 'workflowId');
        const path = `${basePath}/${safeWorkflowId}`;
        const response = await fetchOperation(
          path,
          { method: 'DELETE', headers },
          WORKFLOW_READ_TIMEOUT_MS,
        );
        if (!response.ok) {
          return readError(response, 'DELETE', path);
        }
        return success(await response.json().catch(() => ({ success: true })));
      }

      default:
        return error(`Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(
      `platform_workflows ${action} failed: ${message}`,
      'Workflow endpoints are served by the Studio API (port 5173), which proxies to the runtime (port 3112). Ensure both are running.',
    );
  }
}

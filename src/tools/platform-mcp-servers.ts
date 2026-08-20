/** MCP server provisioning, discovery, import, and testing. */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import {
  formatStudioFailure,
  requestStudioJson,
  type StudioApiDependencies,
} from '../utils/studio-api.js';
import { validatePathParam } from '../utils/validate.js';
import { findSensitiveFieldPath, sanitizeResponse } from '../utils/sanitize.js';

const MCP_SERVER_TIMEOUT_MS = 30_000;

export const platformMcpServersSchema = z.object({
  action: z.enum([
    'list',
    'get',
    'create',
    'update',
    'delete',
    'test_connection',
    'authorize',
    'grant_status',
    'disconnect',
    'discover_preview',
    'discover_import',
    'list_tools',
    'test_tool',
  ]),
  projectId: z.string().min(1),
  serverId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  transport: z.enum(['sse', 'http']).optional(),
  url: z.string().url().optional(),
  authType: z
    .literal('none')
    .optional()
    .describe('Only "none" is accepted inline; use authProfileId for authenticated servers'),
  authProfileId: z.string().min(1).nullable().optional(),
  tlsAuthProfileId: z.string().min(1).nullable().optional(),
  consentMode: z.enum(['preflight', 'inline']).optional(),
  priority: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
  connectionTimeoutMs: z.number().int().positive().optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  autoReconnect: z.boolean().optional(),
  maxReconnectAttempts: z.number().int().nonnegative().optional(),
  purpose: z.enum(['execution', 'discovery']).optional(),
  userId: z.string().min(1).optional(),
  toolNames: z.array(z.string().min(1)).optional(),
  toolName: z.string().min(1).optional(),
  input: z.record(z.unknown()).optional(),
  confirm: z.boolean().optional(),
});

export type PlatformMcpServersArgs = z.infer<typeof platformMcpServersSchema>;

function error(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(sanitizeResponse({ success: false, error: message, ...extra }));
}

function serverBody(args: PlatformMcpServersArgs): Record<string, unknown> {
  return {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.transport !== undefined ? { transport: args.transport } : {}),
    ...(args.url !== undefined ? { url: args.url } : {}),
    ...(args.authType !== undefined ? { authType: args.authType } : {}),
    ...(args.authProfileId !== undefined ? { authProfileId: args.authProfileId } : {}),
    ...(args.tlsAuthProfileId !== undefined ? { tlsAuthProfileId: args.tlsAuthProfileId } : {}),
    ...(args.consentMode !== undefined ? { consentMode: args.consentMode } : {}),
    ...(args.priority !== undefined ? { priority: args.priority } : {}),
    ...(args.tags !== undefined ? { tags: args.tags } : {}),
    ...(args.connectionTimeoutMs !== undefined
      ? { connectionTimeoutMs: args.connectionTimeoutMs }
      : {}),
    ...(args.requestTimeoutMs !== undefined ? { requestTimeoutMs: args.requestTimeoutMs } : {}),
    ...(args.autoReconnect !== undefined ? { autoReconnect: args.autoReconnect } : {}),
    ...(args.maxReconnectAttempts !== undefined
      ? { maxReconnectAttempts: args.maxReconnectAttempts }
      : {}),
  };
}

export async function platformMcpServers(
  args: PlatformMcpServersArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  const projectId = validatePathParam(args.projectId, 'projectId');
  const unsafePath = findSensitiveFieldPath(args);
  if (unsafePath) {
    return error(`Raw credential field "${unsafePath}" is not allowed in MCP arguments.`);
  }
  const basePath = `/api/projects/${projectId}/mcp-servers`;
  const serverPath = args.serverId
    ? `${basePath}/${validatePathParam(args.serverId, 'serverId')}`
    : null;
  let method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET';
  let path = basePath;
  let body: unknown;

  switch (args.action) {
    case 'list':
      break;
    case 'get':
      if (!serverPath) return error('serverId is required for the get action.');
      path = serverPath;
      break;
    case 'create':
      if (!args.name || !args.transport) {
        return error('name and transport are required for the create action.');
      }
      if (!args.url) return error('url is required for the create action.');
      method = 'POST';
      body = serverBody(args);
      break;
    case 'update':
      if (!serverPath) return error('serverId is required for the update action.');
      method = 'PUT';
      path = serverPath;
      body = serverBody(args);
      if (Object.keys(body as Record<string, unknown>).length === 0) {
        return error('At least one field is required for the update action.');
      }
      break;
    case 'delete':
      if (!serverPath) return error('serverId is required for the delete action.');
      if (args.confirm !== true) {
        return error('Deleting an MCP server requires confirm: true.', {
          needsConfirmation: true,
        });
      }
      method = 'DELETE';
      path = serverPath;
      break;
    case 'test_connection':
      if (!serverPath) return error('serverId is required for the test_connection action.');
      method = 'POST';
      path = `${serverPath}/test-connection`;
      body = {};
      break;
    case 'authorize':
      if (!serverPath) return error('serverId is required for the authorize action.');
      method = 'POST';
      path = `${serverPath}/authorize`;
      body = args.purpose ? { purpose: args.purpose } : {};
      break;
    case 'grant_status':
      if (!serverPath) return error('serverId is required for the grant_status action.');
      path = `${serverPath}/grant-status`;
      break;
    case 'disconnect':
      if (!serverPath) return error('serverId is required for the disconnect action.');
      if (args.confirm !== true) {
        return error('Disconnecting MCP authorization requires confirm: true.', {
          needsConfirmation: true,
        });
      }
      method = 'POST';
      path = `${serverPath}/disconnect`;
      body = args.userId ? { userId: args.userId } : {};
      break;
    case 'discover_preview':
      if (!serverPath) return error('serverId is required for the discover_preview action.');
      method = 'POST';
      path = `${serverPath}/tools/discover/preview`;
      body = {};
      break;
    case 'discover_import':
      if (!serverPath) return error('serverId is required for the discover_import action.');
      method = 'POST';
      path = `${serverPath}/tools/discover`;
      body = args.toolNames ? { toolNames: args.toolNames } : {};
      break;
    case 'list_tools':
      if (!serverPath) return error('serverId is required for the list_tools action.');
      path = `${serverPath}/tools`;
      break;
    case 'test_tool':
      if (!serverPath) return error('serverId is required for the test_tool action.');
      if (!args.toolName) return error('toolName is required for the test_tool action.');
      method = 'POST';
      path = `${serverPath}/tools/${encodeURIComponent(args.toolName)}/test`;
      body = { input: args.input ?? {} };
      break;
  }

  try {
    const result = await requestStudioJson(
      ctx,
      { method, path, ...(body !== undefined ? { body } : {}), timeoutMs: MCP_SERVER_TIMEOUT_MS },
      dependencies,
    );
    return result.ok
      ? JSON.stringify(result.body, null, 2)
      : formatStudioFailure(path, result, method);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(`platform_mcp_servers ${args.action} failed: ${message}`);
  }
}

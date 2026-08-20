/** Connector/integration connection management for the published Arch MCP server. */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import {
  formatStudioFailure,
  requestStudioJson,
  type StudioApiDependencies,
} from '../utils/studio-api.js';
import { validatePathParam } from '../utils/validate.js';
import { findSensitiveFieldPath, sanitizeResponse } from '../utils/sanitize.js';

const INTEGRATION_TIMEOUT_MS = 15_000;

export const platformIntegrationsSchema = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'test', 'delete']),
  projectId: z.string().min(1),
  connectionId: z.string().min(1).optional(),
  connectorName: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  authProfileId: z.string().min(1).optional(),
  scope: z.enum(['tenant', 'user']).optional(),
  status: z.enum(['active', 'expired', 'revoked']).optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  confirm: z.boolean().optional(),
});

export type PlatformIntegrationsArgs = z.infer<typeof platformIntegrationsSchema>;

function error(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(sanitizeResponse({ success: false, error: message, ...extra }));
}

export async function platformIntegrations(
  args: PlatformIntegrationsArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  const projectId = validatePathParam(args.projectId, 'projectId');
  const unsafePath = findSensitiveFieldPath(args);
  if (unsafePath) {
    return error(`Raw credential field "${unsafePath}" is not allowed in MCP arguments.`);
  }
  const basePath = `/api/projects/${projectId}/connections`;
  const connectionPath = args.connectionId
    ? `${basePath}/${validatePathParam(args.connectionId, 'connectionId')}`
    : null;
  let method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET';
  let path = basePath;
  let body: unknown;

  switch (args.action) {
    case 'list':
      break;
    case 'get':
      if (!connectionPath) return error('connectionId is required for the get action.');
      path = connectionPath;
      break;
    case 'create':
      if (!args.connectorName || !args.displayName || !args.authProfileId) {
        return error(
          'connectorName, displayName, and authProfileId are required for the create action.',
        );
      }
      method = 'POST';
      body = {
        connectorName: args.connectorName,
        displayName: args.displayName,
        authProfileId: args.authProfileId,
        ...(args.scope ? { scope: args.scope } : {}),
        ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      };
      break;
    case 'update':
      if (!connectionPath) return error('connectionId is required for the update action.');
      method = 'PUT';
      path = connectionPath;
      body = {
        ...(args.displayName ? { displayName: args.displayName } : {}),
        ...(args.authProfileId ? { authProfileId: args.authProfileId } : {}),
        ...(args.status ? { status: args.status } : {}),
        ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      };
      if (Object.keys(body as Record<string, unknown>).length === 0) {
        return error('At least one field is required for the update action.');
      }
      break;
    case 'test':
      if (!connectionPath) return error('connectionId is required for the test action.');
      method = 'POST';
      path = `${connectionPath}/test`;
      break;
    case 'delete':
      if (!connectionPath) return error('connectionId is required for the delete action.');
      if (args.confirm !== true) {
        return error('Deleting an integration connection requires confirm: true.', {
          needsConfirmation: true,
        });
      }
      method = 'DELETE';
      path = connectionPath;
      break;
  }

  try {
    const result = await requestStudioJson(
      ctx,
      { method, path, ...(body !== undefined ? { body } : {}), timeoutMs: INTEGRATION_TIMEOUT_MS },
      dependencies,
    );
    return result.ok
      ? JSON.stringify(result.body, null, 2)
      : formatStudioFailure(path, result, method);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(`platform_integrations ${args.action} failed: ${message}`);
  }
}

/**
 * platform_arch_auto_loop Tool
 *
 * Thin MCP wrapper over Studio-owned Arch Auto Loop APIs.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import {
  requestStudioJson,
  formatStudioFailure,
  type StudioApiDependencies,
} from '../utils/studio-api.js';
import { sanitizeResponse } from '../utils/sanitize.js';
import { validatePathParam } from '../utils/validate.js';

const bodySchema = z.record(z.unknown()).optional();

export const platformArchAutoLoopSchema = z.object({
  action: z.enum(['list', 'create', 'get', 'execute_action', 'record_decision']),
  projectId: z.string().describe('Project ID'),
  runId: z.string().optional().describe('Arch Auto Loop run ID for run-scoped actions'),
  body: bodySchema.describe('Request body for create, execute_action, or record_decision'),
});

type PlatformArchAutoLoopArgs = z.infer<typeof platformArchAutoLoopSchema>;

export async function platformArchAutoLoop(
  args: PlatformArchAutoLoopArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  try {
    const basePath = `/api/projects/${validatePathParam(args.projectId, 'projectId')}/arch-auto-loop/runs`;

    switch (args.action) {
      case 'list':
        return studioRequest(ctx, 'GET', basePath, undefined, dependencies);
      case 'create':
        return studioRequest(ctx, 'POST', basePath, args.body ?? {}, dependencies, 60_000);
      case 'get':
        return studioRequest(
          ctx,
          'GET',
          `${basePath}/${requireId(args.runId, 'runId')}`,
          undefined,
          dependencies,
        );
      case 'execute_action':
        return studioRequest(
          ctx,
          'POST',
          `${basePath}/${requireId(args.runId, 'runId')}/actions`,
          args.body ?? {},
          dependencies,
          60_000,
        );
      case 'record_decision':
        return studioRequest(
          ctx,
          'POST',
          `${basePath}/${requireId(args.runId, 'runId')}/decisions`,
          args.body ?? {},
          dependencies,
          60_000,
        );
    }
  } catch (err) {
    return jsonError(err);
  }
}

function requireId(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required for this action.`);
  }
  return validatePathParam(value, name);
}

async function studioRequest(
  ctx: DebugContext,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  dependencies?: StudioApiDependencies,
  timeoutMs?: number,
): Promise<string> {
  const result = await requestStudioJson(
    ctx,
    {
      method,
      path,
      ...(body !== undefined ? { body } : {}),
      timeoutMs: timeoutMs ?? (method === 'GET' ? 15_000 : 30_000),
    },
    dependencies,
  );

  if (!result.ok) {
    return formatStudioFailure(path, result, method);
  }

  return JSON.stringify({ success: true, data: sanitizeResponse(result.body) }, null, 2);
}

function jsonError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return JSON.stringify({ success: false, error: message }, null, 2);
}

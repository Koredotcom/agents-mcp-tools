/**
 * MCP wrappers for Studio eval APIs.
 *
 * These tools intentionally route to the mounted `/evals/*` API paths, not the
 * old singular `/eval-personas` style paths from stale docs.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import {
  requestStudioJson,
  formatStudioFailure,
  type StudioApiDependencies,
} from '../utils/studio-api.js';
import { sanitizeResponse } from '../utils/sanitize.js';
import { sanitizeEvalPreflightResponse } from '../utils/eval-preflight-sanitizer.js';
import { validatePathParam } from '../utils/validate.js';

const querySchema = z.record(z.union([z.string(), z.number(), z.boolean()])).optional();
const bodySchema = z.record(z.unknown()).optional();

export const platformEvalPersonasSchema = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'delete', 'templates', 'generate']),
  projectId: z.string().describe('Project ID'),
  personaId: z.string().optional().describe('Persona ID for get/update/delete'),
  query: querySchema.describe('Optional query params for list'),
  body: bodySchema.describe('Request body for create/update/generate'),
  confirm: z.boolean().optional().describe('Set true for delete'),
});

export const platformEvalScenariosSchema = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'delete', 'generate']),
  projectId: z.string().describe('Project ID'),
  scenarioId: z.string().optional().describe('Scenario ID for get/update/delete'),
  query: querySchema.describe('Optional query params for list'),
  body: bodySchema.describe('Request body for create/update/generate'),
  confirm: z.boolean().optional().describe('Set true for delete'),
});

export const platformEvalEvaluatorsSchema = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'delete', 'templates']),
  projectId: z.string().describe('Project ID'),
  evaluatorId: z.string().optional().describe('Evaluator ID for get/update/delete'),
  query: querySchema.describe('Optional query params for list'),
  body: bodySchema.describe('Request body for create/update'),
  confirm: z.boolean().optional().describe('Set true for delete'),
});

export const platformEvalSetsSchema = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'delete']),
  projectId: z.string().describe('Project ID'),
  setId: z.string().optional().describe('Eval set ID for get/update/delete'),
  query: querySchema.describe('Optional query params for list'),
  body: bodySchema.describe('Request body for create/update'),
  confirm: z.boolean().optional().describe('Set true for delete'),
});

export const platformEvalRunsSchema = z.object({
  action: z.enum([
    'list',
    'get',
    'create',
    'update',
    'start',
    'cancel',
    'status',
    'heatmap',
    'cases',
    'compare',
    'preflight',
    'quick',
  ]),
  projectId: z.string().describe('Project ID'),
  runId: z.string().optional().describe('Run ID for get/update/start/cancel/status/heatmap/cases'),
  runIds: z
    .array(z.string())
    .optional()
    .describe('Exactly two run IDs for compare. Prefer this over query.runIds.'),
  query: querySchema.describe('Optional query params for list/compare/heatmap'),
  body: bodySchema.describe('Request body for create/update/start/cancel/quick'),
});

type PlatformEvalPersonasArgs = z.infer<typeof platformEvalPersonasSchema>;
type PlatformEvalScenariosArgs = z.infer<typeof platformEvalScenariosSchema>;
type PlatformEvalEvaluatorsArgs = z.infer<typeof platformEvalEvaluatorsSchema>;
type PlatformEvalSetsArgs = z.infer<typeof platformEvalSetsSchema>;
type PlatformEvalRunsArgs = z.infer<typeof platformEvalRunsSchema>;

type Collection = 'personas' | 'scenarios' | 'evaluators' | 'sets';

const COLLECTION_ID_PARAM: Record<Collection, string> = {
  personas: 'personaId',
  scenarios: 'scenarioId',
  evaluators: 'evaluatorId',
  sets: 'setId',
};

export async function platformEvalPersonas(
  args: PlatformEvalPersonasArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  if (args.action === 'generate') {
    return runProjectAction(
      ctx,
      args.projectId,
      'generate/personas',
      args.body ?? {},
      undefined,
      dependencies,
    );
  }
  return runCollectionTool(
    ctx,
    {
      projectId: args.projectId,
      collection: 'personas',
      action: args.action,
      id: args.personaId,
      query: args.query,
      body: args.body,
      confirm: args.confirm,
    },
    dependencies,
  );
}

export async function platformEvalScenarios(
  args: PlatformEvalScenariosArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  if (args.action === 'generate') {
    return runProjectAction(
      ctx,
      args.projectId,
      'generate/scenarios',
      args.body ?? {},
      undefined,
      dependencies,
    );
  }
  return runCollectionTool(
    ctx,
    {
      projectId: args.projectId,
      collection: 'scenarios',
      action: args.action,
      id: args.scenarioId,
      query: args.query,
      body: args.body,
      confirm: args.confirm,
    },
    dependencies,
  );
}

export async function platformEvalEvaluators(
  args: PlatformEvalEvaluatorsArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  return runCollectionTool(
    ctx,
    {
      projectId: args.projectId,
      collection: 'evaluators',
      action: args.action,
      id: args.evaluatorId,
      query: args.query,
      body: args.body,
      confirm: args.confirm,
    },
    dependencies,
  );
}

export async function platformEvalSets(
  args: PlatformEvalSetsArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  return runCollectionTool(
    ctx,
    {
      projectId: args.projectId,
      collection: 'sets',
      action: args.action,
      id: args.setId,
      query: args.query,
      body: args.body,
      confirm: args.confirm,
    },
    dependencies,
  );
}

export async function platformEvalRuns(
  args: PlatformEvalRunsArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  try {
    const basePath = evalBasePath(args.projectId, 'runs');

    switch (args.action) {
      case 'list':
        return studioRequest(
          ctx,
          'GET',
          withQuery(basePath, args.query),
          undefined,
          undefined,
          dependencies,
        );
      case 'create':
        return studioRequest(ctx, 'POST', basePath, args.body ?? {}, undefined, dependencies);
      case 'preflight':
        return runProjectAction(
          ctx,
          args.projectId,
          'preflight',
          args.body ?? {},
          {
            sanitizeBody: sanitizeEvalPreflightResponse,
          },
          dependencies,
        );
      case 'quick':
        return runProjectAction(
          ctx,
          args.projectId,
          'quick',
          args.body ?? {},
          undefined,
          dependencies,
        );
      case 'compare':
        return studioRequest(
          ctx,
          'GET',
          withQuery(`${basePath}/compare`, compareQuery(args)),
          undefined,
          undefined,
          dependencies,
        );
      case 'get':
        return studioRequest(
          ctx,
          'GET',
          `${basePath}/${requireId(args.runId, 'runId')}`,
          undefined,
          undefined,
          dependencies,
        );
      case 'update':
        return studioRequest(
          ctx,
          'PATCH',
          `${basePath}/${requireId(args.runId, 'runId')}`,
          args.body ?? {},
          undefined,
          dependencies,
        );
      case 'start':
        return studioRequest(
          ctx,
          'POST',
          `${basePath}/${requireId(args.runId, 'runId')}/start`,
          args.body ?? {},
          undefined,
          dependencies,
        );
      case 'cancel':
        return studioRequest(
          ctx,
          'POST',
          `${basePath}/${requireId(args.runId, 'runId')}/cancel`,
          args.body ?? {},
          undefined,
          dependencies,
        );
      case 'status':
        return studioRequest(
          ctx,
          'GET',
          `${basePath}/${requireId(args.runId, 'runId')}/status`,
          undefined,
          undefined,
          dependencies,
        );
      case 'heatmap':
        return studioRequest(
          ctx,
          'GET',
          withQuery(`${basePath}/${requireId(args.runId, 'runId')}/heatmap`, args.query),
          undefined,
          undefined,
          dependencies,
        );
      case 'cases':
        return studioRequest(
          ctx,
          'GET',
          withQuery(`${basePath}/${requireId(args.runId, 'runId')}/cases`, args.query),
          undefined,
          undefined,
          dependencies,
        );
    }
  } catch (err) {
    return jsonError(err);
  }
}

async function runCollectionTool(
  ctx: DebugContext,
  input: {
    projectId: string;
    collection: Collection;
    action: 'list' | 'get' | 'create' | 'update' | 'delete' | 'templates';
    id?: string;
    query?: Record<string, string | number | boolean>;
    body?: Record<string, unknown>;
    confirm?: boolean;
  },
  dependencies?: StudioApiDependencies,
): Promise<string> {
  try {
    const basePath = evalBasePath(input.projectId, input.collection);
    const idParam = COLLECTION_ID_PARAM[input.collection];

    switch (input.action) {
      case 'list':
        return studioRequest(
          ctx,
          'GET',
          withQuery(basePath, input.query),
          undefined,
          undefined,
          dependencies,
        );
      case 'templates':
        return studioRequest(
          ctx,
          'GET',
          `${basePath}/templates`,
          undefined,
          undefined,
          dependencies,
        );
      case 'create':
        return studioRequest(ctx, 'POST', basePath, input.body ?? {}, undefined, dependencies);
      case 'get':
        return studioRequest(
          ctx,
          'GET',
          `${basePath}/${requireId(input.id, idParam)}`,
          undefined,
          undefined,
          dependencies,
        );
      case 'update':
        return studioRequest(
          ctx,
          'PATCH',
          `${basePath}/${requireId(input.id, idParam)}`,
          input.body ?? {},
          undefined,
          dependencies,
        );
      case 'delete':
        if (input.confirm !== true) {
          return JSON.stringify(
            {
              success: false,
              needsConfirmation: true,
              message: `This will delete the eval ${input.collection.slice(0, -1)}. Set confirm: true to proceed.`,
            },
            null,
            2,
          );
        }
        return studioRequest(
          ctx,
          'DELETE',
          `${basePath}/${requireId(input.id, idParam)}`,
          undefined,
          undefined,
          dependencies,
        );
    }
  } catch (err) {
    return jsonError(err);
  }
}

function runProjectAction(
  ctx: DebugContext,
  projectId: string,
  actionPath: string,
  body: Record<string, unknown>,
  options?: { sanitizeBody?: (body: unknown) => unknown },
  dependencies?: StudioApiDependencies,
): Promise<string> {
  try {
    const basePath = `/api/projects/${validatePathParam(projectId, 'projectId')}/evals`;
    return studioRequest(ctx, 'POST', `${basePath}/${actionPath}`, body, options, dependencies);
  } catch (err) {
    return Promise.resolve(jsonError(err));
  }
}

function evalBasePath(projectId: string, collection: Collection | 'runs'): string {
  return `/api/projects/${validatePathParam(projectId, 'projectId')}/evals/${collection}`;
}

function requireId(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required for this action.`);
  }
  return validatePathParam(value, name);
}

function withQuery(path: string, query?: Record<string, string | number | boolean>): string {
  if (!query || Object.keys(query).length === 0) {
    return path;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value));
  }
  return `${path}?${params.toString()}`;
}

function compareQuery(args: PlatformEvalRunsArgs): Record<string, string | number | boolean> {
  if (args.runIds) {
    const runIds = args.runIds.map((id) => id.trim()).filter(Boolean);
    if (runIds.length !== 2) {
      throw new Error('runIds must contain exactly two run IDs for compare.');
    }
    return {
      ...(args.query ?? {}),
      runIds: runIds.join(','),
    };
  }

  const rawRunIds = args.query?.runIds;
  if (typeof rawRunIds === 'string' && rawRunIds.length > 0) {
    const ids = rawRunIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length !== 2) {
      throw new Error('query.runIds must contain exactly two comma-separated run IDs for compare.');
    }
    return args.query ?? {};
  }

  throw new Error('runIds is required for compare.');
}

async function studioRequest(
  ctx: DebugContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  options?: { sanitizeBody?: (body: unknown) => unknown },
  dependencies?: StudioApiDependencies,
): Promise<string> {
  try {
    const result = await requestStudioJson(
      ctx,
      {
        method,
        path,
        ...(body !== undefined ? { body } : {}),
        timeoutMs: method === 'GET' ? 15_000 : 30_000,
      },
      dependencies,
    );

    if (!result.ok) {
      return formatStudioFailure(path, result, method);
    }

    const responseBody = options?.sanitizeBody ? options.sanitizeBody(result.body) : result.body;
    return JSON.stringify({ success: true, data: sanitizeResponse(responseBody) }, null, 2);
  } catch (err) {
    return jsonError(err);
  }
}

function jsonError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return JSON.stringify({ success: false, error: message }, null, 2);
}

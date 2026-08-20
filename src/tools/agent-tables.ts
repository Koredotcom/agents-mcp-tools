/**
 * agent_tables Tool
 *
 * Manage and inspect Agent Tables through the platform Runtime API.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { fetchWithTimeout } from '../utils/fetch.js';
import { sanitizeResponse } from '../utils/sanitize.js';
import { validatePathParam } from '../utils/validate.js';

const FETCH_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 30_000;

const columnSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum([
      'string',
      'integer',
      'number',
      'boolean',
      'datetime',
      'enum',
      'reference',
      'json',
    ]),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    indexed: z.boolean().optional(),
    unique: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    enumValues: z.array(z.string()).optional(),
    referenceColumn: z
      .object({
        table: z.string().min(1),
        column: z.string().min(1),
        onDelete: z.enum(['restrict', 'set_null', 'cascade']),
      })
      .optional(),
    order: z.number().optional(),
  })
  .strict();

const tableInputSchema = z
  .object({
    name: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string().optional(),
    scope: z.enum(['project', 'end_user', 'session']).optional(),
    columns: z.array(columnSchema).min(1),
  })
  .strict();

const tablePatchSchema = z
  .object({
    displayName: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

const migrationSchema = z
  .object({
    kind: z.enum(['add_column', 'add_index', 'drop_column', 'retype', 'enum_change']),
    column: z.string().optional(),
    columnDef: columnSchema.optional(),
  })
  .strict();

export const agentTablesSchema = z.object({
  action: z.enum([
    'availability',
    'list',
    'describe',
    'create',
    'update',
    'migrate',
    'delete',
    'insert',
    'query',
    'get_row',
    'update_row',
    'delete_row',
    'upsert',
    'reveal',
  ]),
  projectId: z.string().min(1).describe('Project ID'),
  table: z.string().min(1).optional().describe('Table slug/name for table-specific actions'),
  environment: z
    .string()
    .min(1)
    .optional()
    .describe('Target deployment environment for availability checks'),
  deploymentId: z
    .string()
    .min(1)
    .optional()
    .describe('Deployment ID for direct availability checks'),
  invocationMode: z
    .enum(['direct', 'studio_debug', 'workflow'])
    .optional()
    .describe('Invocation path to evaluate for availability; defaults to direct'),
  tableDefinition: tableInputSchema.optional().describe('Table definition for create'),
  patch: tablePatchSchema.optional().describe('Display metadata patch for update'),
  migration: migrationSchema.optional().describe('Schema migration request'),
  rows: z
    .union([z.record(z.unknown()), z.array(z.record(z.unknown()))])
    .optional()
    .describe('Row or rows for insert/upsert'),
  rowId: z.string().min(1).optional().describe('Row ID for row-specific actions'),
  rowVersion: z.number().int().positive().optional().describe('Optimistic row version'),
  query: z
    .record(z.unknown())
    .optional()
    .describe('Structured query, predicate query, or SQL body'),
  count: z.boolean().optional().describe('Return count for legacy GET query'),
  onKey: z.array(z.string().min(1)).optional().describe('Unique key columns for upsert'),
  columns: z.array(z.string().min(1)).optional().describe('Sensitive columns to reveal'),
  confirm: z.boolean().optional().describe('Set true to confirm destructive delete operations'),
});

export type AgentTablesArgs = z.infer<typeof agentTablesSchema>;

export interface AgentTablesDependencies {
  fetchWithTimeout: typeof fetchWithTimeout;
}

const defaultAgentTablesDependencies: AgentTablesDependencies = {
  fetchWithTimeout,
};

function success(data: unknown, options: { sanitize?: boolean } = {}): string {
  return JSON.stringify({
    success: true,
    data: options.sanitize === false ? data : sanitizeResponse(data),
  });
}

function error(message: string, hint?: string): string {
  return JSON.stringify({ success: false, error: message, ...(hint ? { hint } : {}) });
}

function runtimeHeaders(ctx: DebugContext, hasBody = false): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = ctx.httpClient.getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (hasBody) headers['Content-Type'] = 'application/json';
  return headers;
}

function tableBaseUrl(ctx: DebugContext, projectId: string): string {
  const baseUrl = ctx.httpClient.getBaseUrl();
  const safeProjectId = validatePathParam(projectId, 'projectId');
  return `${baseUrl}/api/projects/${safeProjectId}/tables`;
}

function tableUrl(ctx: DebugContext, projectId: string, table: string): string {
  return `${tableBaseUrl(ctx, projectId)}/${validatePathParam(table, 'table')}`;
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  dependencies: AgentTablesDependencies,
): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  const response = await dependencies.fetchWithTimeout(url, init, timeoutMs);
  if (!response.ok) {
    return {
      ok: false,
      message: `${init.method ?? 'GET'} ${url} failed: ${response.status} ${response.statusText}`,
    };
  }
  if (response.status === 204) return { ok: true, data: {} };
  return { ok: true, data: await response.json() };
}

function requireTable(args: AgentTablesArgs): string | null {
  return args.table ?? null;
}

export async function agentTables(
  args: AgentTablesArgs,
  ctx: DebugContext,
  dependencies: AgentTablesDependencies = defaultAgentTablesDependencies,
): Promise<string> {
  try {
    const basePath = tableBaseUrl(ctx, args.projectId);
    const headers = runtimeHeaders(ctx);

    switch (args.action) {
      case 'availability': {
        const searchParams = new URLSearchParams();
        if (args.environment) searchParams.set('environment', args.environment);
        if (args.deploymentId) searchParams.set('deploymentId', args.deploymentId);
        if (args.invocationMode) searchParams.set('invocationMode', args.invocationMode);
        const query = searchParams.toString();
        const url = `${basePath}/availability${query ? `?${query}` : ''}`;
        const result = await requestJson(url, { headers }, FETCH_TIMEOUT_MS, dependencies);
        return result.ok ? success(result.data) : error(result.message);
      }

      case 'list': {
        const result = await requestJson(basePath, { headers }, FETCH_TIMEOUT_MS, dependencies);
        return result.ok ? success(result.data) : error(result.message);
      }

      case 'describe': {
        const table = requireTable(args);
        if (!table) return error('table is required for describe.');
        const result = await requestJson(
          tableUrl(ctx, args.projectId, table),
          { headers },
          FETCH_TIMEOUT_MS,
          dependencies,
        );
        return result.ok ? success(result.data) : error(result.message);
      }

      case 'create': {
        if (!args.tableDefinition) return error('tableDefinition is required for create.');
        const result = await requestJson(
          basePath,
          {
            method: 'POST',
            headers: runtimeHeaders(ctx, true),
            body: JSON.stringify(args.tableDefinition),
          },
          MUTATION_TIMEOUT_MS,
          dependencies,
        );
        return result.ok ? success(result.data) : error(result.message);
      }

      case 'update': {
        const table = requireTable(args);
        if (!table) return error('table is required for update.');
        if (!args.patch) return error('patch is required for update.');
        const result = await requestJson(
          tableUrl(ctx, args.projectId, table),
          {
            method: 'PATCH',
            headers: runtimeHeaders(ctx, true),
            body: JSON.stringify(args.patch),
          },
          MUTATION_TIMEOUT_MS,
          dependencies,
        );
        return result.ok ? success(result.data) : error(result.message);
      }

      case 'migrate': {
        const table = requireTable(args);
        if (!table) return error('table is required for migrate.');
        if (!args.migration) return error('migration is required for migrate.');
        const result = await requestJson(
          `${tableUrl(ctx, args.projectId, table)}/migrate`,
          {
            method: 'POST',
            headers: runtimeHeaders(ctx, true),
            body: JSON.stringify(args.migration),
          },
          MUTATION_TIMEOUT_MS,
          dependencies,
        );
        return result.ok ? success(result.data) : error(result.message);
      }

      case 'delete': {
        const table = requireTable(args);
        if (!table) return error('table is required for delete.');
        if (args.confirm !== true) {
          return JSON.stringify({
            success: false,
            needsConfirmation: true,
            message:
              'This permanently deletes the Agent Table definition and its rows. Set confirm: true to proceed.',
          });
        }
        const result = await requestJson(
          tableUrl(ctx, args.projectId, table),
          {
            method: 'DELETE',
            headers,
          },
          MUTATION_TIMEOUT_MS,
          dependencies,
        );
        return result.ok ? success(result.data) : error(result.message);
      }

      case 'insert': {
        const table = requireTable(args);
        if (!table) return error('table is required for insert.');
        if (!args.rows) return error('rows is required for insert.');
        const result = await requestJson(
          `${tableUrl(ctx, args.projectId, table)}/rows`,
          {
            method: 'POST',
            headers: runtimeHeaders(ctx, true),
            body: JSON.stringify(args.rows),
          },
          MUTATION_TIMEOUT_MS,
          dependencies,
        );
        return result.ok ? success(result.data) : error(result.message);
      }

      case 'query': {
        const table = requireTable(args);
        if (!table) return error('table is required for query.');
        const body = args.query ?? {};
        if (args.count) {
          const searchParams = new URLSearchParams();
          searchParams.set('count', 'true');
          searchParams.set('q', JSON.stringify(body));
          const result = await requestJson(
            `${tableUrl(ctx, args.projectId, table)}/rows?${searchParams.toString()}`,
            { headers },
            FETCH_TIMEOUT_MS,
            dependencies,
          );
          return result.ok ? success(result.data) : error(result.message);
        }
        const result = await requestJson(
          `${tableUrl(ctx, args.projectId, table)}/rows/query`,
          {
            method: 'POST',
            headers: runtimeHeaders(ctx, true),
            body: JSON.stringify(body),
          },
          FETCH_TIMEOUT_MS,
          dependencies,
        );
        return result.ok ? success(result.data) : error(result.message);
      }

      case 'get_row': {
        const table = requireTable(args);
        if (!table) return error('table is required for get_row.');
        if (!args.rowId) return error('rowId is required for get_row.');
        const result = await requestJson(
          `${tableUrl(ctx, args.projectId, table)}/rows/${validatePathParam(args.rowId, 'rowId')}`,
          { headers },
          FETCH_TIMEOUT_MS,
          dependencies,
        );
        return result.ok ? success(result.data) : error(result.message);
      }

      case 'update_row': {
        const table = requireTable(args);
        if (!table) return error('table is required for update_row.');
        if (!args.rowId) return error('rowId is required for update_row.');
        if (!args.rows || Array.isArray(args.rows)) {
          return error('rows must be a single object for update_row.');
        }
        if (args.rowVersion === undefined) return error('rowVersion is required for update_row.');
        const result = await requestJson(
          `${tableUrl(ctx, args.projectId, table)}/rows/${validatePathParam(args.rowId, 'rowId')}`,
          {
            method: 'PATCH',
            headers: runtimeHeaders(ctx, true),
            body: JSON.stringify({ values: args.rows, rowVersion: args.rowVersion }),
          },
          MUTATION_TIMEOUT_MS,
          dependencies,
        );
        return result.ok ? success(result.data) : error(result.message);
      }

      case 'delete_row': {
        const table = requireTable(args);
        if (!table) return error('table is required for delete_row.');
        if (!args.rowId) return error('rowId is required for delete_row.');
        if (args.confirm !== true) {
          return JSON.stringify({
            success: false,
            needsConfirmation: true,
            message: 'This permanently deletes the row. Set confirm: true to proceed.',
          });
        }
        const searchParams = new URLSearchParams();
        if (args.rowVersion !== undefined) searchParams.set('rowVersion', String(args.rowVersion));
        const query = searchParams.toString();
        const result = await requestJson(
          `${tableUrl(ctx, args.projectId, table)}/rows/${validatePathParam(args.rowId, 'rowId')}${query ? `?${query}` : ''}`,
          {
            method: 'DELETE',
            headers,
          },
          MUTATION_TIMEOUT_MS,
          dependencies,
        );
        return result.ok ? success(result.data) : error(result.message);
      }

      case 'upsert': {
        const table = requireTable(args);
        if (!table) return error('table is required for upsert.');
        if (!args.rows) return error('rows is required for upsert.');
        if (!args.onKey) return error('onKey is required for upsert.');
        const result = await requestJson(
          `${tableUrl(ctx, args.projectId, table)}/upsert`,
          {
            method: 'POST',
            headers: runtimeHeaders(ctx, true),
            body: JSON.stringify({ rows: args.rows, onKey: args.onKey }),
          },
          MUTATION_TIMEOUT_MS,
          dependencies,
        );
        return result.ok ? success(result.data) : error(result.message);
      }

      case 'reveal': {
        const table = requireTable(args);
        if (!table) return error('table is required for reveal.');
        if (!args.rowId) return error('rowId is required for reveal.');
        if (!args.columns) return error('columns is required for reveal.');
        const result = await requestJson(
          `${tableUrl(ctx, args.projectId, table)}/rows/${validatePathParam(args.rowId, 'rowId')}/reveal`,
          {
            method: 'POST',
            headers: runtimeHeaders(ctx, true),
            body: JSON.stringify({ columns: args.columns }),
          },
          FETCH_TIMEOUT_MS,
          dependencies,
        );
        return result.ok ? success(result.data, { sanitize: false }) : error(result.message);
      }

      default:
        return error(`Unknown action: ${args.action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(
      `Agent Tables request failed: ${message}`,
      'Ensure platform_connect has completed and the target runtime supports Agent Tables APIs.',
    );
  }
}

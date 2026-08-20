/**
 * platform_import_export Tool
 *
 * Import and export project configurations via the Studio REST API (v2).
 *
 * Endpoints (mounted at /api/projects/:projectId on the Studio origin):
 *   POST /export/preview  — Metadata preview (agents, tools, layers, deps)
 *   GET  /export          — Full export (file map + manifest + lockfile)
 *   POST /import/preview  — Dry-run import (preview changes)
 *   POST /import/apply    — Apply import (staged create/update/delete)
 *
 * After a successful import, if the uploaded files contain a project.json
 * with an entry_agent field, the project's entryAgentName is PATCHed
 * automatically.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { fetchWithTimeout } from '../utils/fetch.js';
import { validatePathParam } from '../utils/validate.js';
import { sanitizeResponse } from '../utils/sanitize.js';
import { loadPackageFiles, readPackageFilesFromData } from '../utils/package-files.js';
import {
  buildStudioHeaders,
  deriveStudioUrl,
  readResponseBody,
  type StudioApiDependencies,
} from '../utils/studio-api.js';

// =============================================================================
// SCHEMA
// =============================================================================

export const platformImportExportSchema = z.object({
  action: z.enum(['export_preview', 'export', 'import_preview', 'import']),
  projectId: z.string().describe('Project ID'),
  data: z.record(z.unknown()).optional().describe('Import data (for import_preview, import)'),
  path: z
    .string()
    .optional()
    .describe('Local project folder or .zip path to import/preview. Alternative to data.files.'),
  files: z
    .record(z.string())
    .optional()
    .describe('Relative path -> UTF-8 file content map. Alternative to path or data.files.'),
  confirm: z
    .boolean()
    .optional()
    .describe('Set to true to confirm destructive operations (import)'),
  previewDigest: z
    .string()
    .optional()
    .describe('Import preview digest to acknowledge before import/apply.'),
  acknowledgedIssueIds: z
    .array(z.string())
    .optional()
    .describe('Non-blocking import issue IDs acknowledged by the caller.'),
  autoAcknowledgeNonBlocking: z
    .boolean()
    .optional()
    .describe(
      'When true, import/apply runs preview first and acknowledges all non-blocking issues if there are no blocking issues. Defaults to true when confirm is true and no acknowledgement fields were supplied.',
    ),
  includeVersionHistory: z
    .boolean()
    .optional()
    .describe('When true, include agent version history in the export.'),
});

type PlatformImportExportArgs = z.infer<typeof platformImportExportSchema>;

const defaultPlatformImportExportDependencies: StudioApiDependencies = {
  fetchWithTimeout,
};

// =============================================================================
// HELPERS
// =============================================================================

function success(data: unknown): string {
  return JSON.stringify({ success: true, data: sanitizeResponse(data) }, null, 2);
}

function error(message: string, hint?: string): string {
  return JSON.stringify({ success: false, error: message, ...(hint ? { hint } : {}) });
}

async function requestFailed(response: Response, method: string, path: string): Promise<string> {
  const body = await readResponseBody(response);
  return JSON.stringify(
    {
      success: false,
      error: `${method} ${path} failed: ${response.status} ${response.statusText}`,
      status: response.status,
      statusText: response.statusText,
      body: sanitizeResponse(body),
    },
    null,
    2,
  );
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const body = await readResponseBody(response);
  return body;
}

async function buildImportPayload(
  args: PlatformImportExportArgs,
): Promise<{ payload: Record<string, unknown>; warnings: string[]; source?: unknown }> {
  const dataFiles = readPackageFilesFromData(args.data);
  if (!args.path && !args.files && !dataFiles) {
    return {
      payload: (args.data ?? {}) as Record<string, unknown>,
      warnings: [],
    };
  }

  const loaded = await loadPackageFiles({ path: args.path, files: args.files ?? dataFiles });
  return {
    payload: {
      ...(args.data ?? {}),
      files: loaded.files,
    },
    warnings: loaded.warnings,
    source: loaded.source,
  };
}

function withAcknowledgementArgs(
  payload: Record<string, unknown>,
  args: PlatformImportExportArgs,
): Record<string, unknown> {
  return {
    ...payload,
    ...(args.previewDigest !== undefined ? { previewDigest: args.previewDigest } : {}),
    ...(args.acknowledgedIssueIds !== undefined
      ? { acknowledgedIssueIds: args.acknowledgedIssueIds }
      : {}),
  };
}

function withoutAcknowledgementArgs(payload: Record<string, unknown>): Record<string, unknown> {
  const {
    previewDigest: _previewDigest,
    acknowledgedIssueIds: _acknowledgedIssueIds,
    ...rest
  } = payload;
  return rest;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPreviewEnvelope(body: unknown): {
  success: boolean | null;
  preview: Record<string, unknown> | null;
  previewDigest: string | null;
} {
  const record = getRecord(body);
  if (!record) {
    return { success: null, preview: null, previewDigest: null };
  }
  const preview = getRecord(record.preview) ?? getRecord(record.result)?.preview ?? null;
  const previewRecord = getRecord(preview);
  const digest =
    typeof record.previewDigest === 'string'
      ? record.previewDigest
      : typeof previewRecord?.previewDigest === 'string'
        ? previewRecord.previewDigest
        : null;
  return {
    success: typeof record.success === 'boolean' ? record.success : null,
    preview: previewRecord,
    previewDigest: digest,
  };
}

function getNonBlockingIssueIds(preview: Record<string, unknown>): string[] {
  const issues = Array.isArray(preview.issues) ? preview.issues : [];
  return issues
    .map((issue) => getRecord(issue))
    .filter((issue): issue is Record<string, unknown> => Boolean(issue))
    .filter((issue) => issue.blocking === false)
    .map((issue) => issue.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function getNonBlockingIssueCount(preview: Record<string, unknown>): number {
  if (typeof preview.nonBlockingIssueCount === 'number') {
    return preview.nonBlockingIssueCount;
  }
  const issues = Array.isArray(preview.issues) ? preview.issues : [];
  return issues.filter((issue) => {
    const record = getRecord(issue);
    return record?.blocking === false;
  }).length;
}

function hasBlockingIssues(preview: Record<string, unknown>): boolean {
  if (preview.hasBlockingIssues === true) {
    return true;
  }
  if (typeof preview.blockingIssueCount === 'number' && preview.blockingIssueCount > 0) {
    return true;
  }
  return (Array.isArray(preview.issues) ? preview.issues : []).some((issue) => {
    const record = getRecord(issue);
    return record?.blocking === true;
  });
}

async function addAutomaticAcknowledgements(input: {
  basePath: string;
  headers: Record<string, string>;
  safeProjectId: string;
  payload: Record<string, unknown>;
  args: PlatformImportExportArgs;
  dependencies: StudioApiDependencies;
}): Promise<
  | { ok: true; payload: Record<string, unknown>; autoAcknowledgement?: Record<string, unknown> }
  | { ok: false; response: string }
> {
  const explicitDigest =
    input.args.previewDigest !== undefined || typeof input.payload.previewDigest === 'string';
  const explicitIds =
    input.args.acknowledgedIssueIds !== undefined ||
    Array.isArray(input.payload.acknowledgedIssueIds);
  const shouldAutoAcknowledge =
    input.args.autoAcknowledgeNonBlocking ?? !(explicitDigest && explicitIds);

  if (!shouldAutoAcknowledge) {
    if (explicitDigest !== explicitIds) {
      return {
        ok: false,
        response: JSON.stringify(
          {
            success: false,
            error:
              'Manual import acknowledgement requires both previewDigest and acknowledgedIssueIds. Provide both, or omit them to let the MCP tool preview and acknowledge non-blocking issues automatically.',
          },
          null,
          2,
        ),
      };
    }
    return { ok: true, payload: withAcknowledgementArgs(input.payload, input.args) };
  }

  const previewPayload = withoutAcknowledgementArgs(input.payload);
  const endpointPath = `/api/projects/${input.safeProjectId}/import/preview`;
  const response = await input.dependencies.fetchWithTimeout(
    `${input.basePath}/import/preview`,
    {
      method: 'POST',
      headers: input.headers,
      body: JSON.stringify(previewPayload),
    },
    30_000,
  );

  if (!response.ok) {
    return { ok: false, response: await requestFailed(response, 'POST', endpointPath) };
  }

  const body = await parseJsonResponse(response);
  const { preview, previewDigest } = readPreviewEnvelope(body);
  if (!preview) {
    return {
      ok: false,
      response: JSON.stringify(
        {
          success: false,
          error: 'Import preview did not return a preview object for acknowledgement.',
          body: sanitizeResponse(body),
        },
        null,
        2,
      ),
    };
  }

  const acknowledgedIssueIds = getNonBlockingIssueIds(preview);
  const nonBlockingIssueCount = getNonBlockingIssueCount(preview);
  if (nonBlockingIssueCount > 0 && !previewDigest) {
    return {
      ok: false,
      response: JSON.stringify(
        {
          success: false,
          error:
            'Import preview reported non-blocking issues but did not return a preview digest for acknowledgement.',
          nonBlockingIssueCount,
          acknowledgedIssueIds,
          preview: sanitizeResponse(preview),
        },
        null,
        2,
      ),
    };
  }

  if (hasBlockingIssues(preview)) {
    return {
      ok: false,
      response: JSON.stringify(
        {
          success: false,
          needsResolution: true,
          message: 'Import preview has blocking issues; fix them before import/apply.',
          previewDigest,
          preview: sanitizeResponse(preview),
        },
        null,
        2,
      ),
    };
  }

  if (acknowledgedIssueIds.length < nonBlockingIssueCount) {
    return {
      ok: false,
      response: JSON.stringify(
        {
          success: false,
          error:
            'Import preview reported non-blocking issues without stable IDs; cannot safely auto-acknowledge.',
          previewDigest,
          nonBlockingIssueCount,
          acknowledgedIssueIds,
          preview: sanitizeResponse(preview),
        },
        null,
        2,
      ),
    };
  }
  return {
    ok: true,
    payload: {
      ...previewPayload,
      ...(previewDigest ? { previewDigest } : {}),
      acknowledgedIssueIds,
    },
    autoAcknowledgement: {
      ...(previewDigest ? { previewDigest } : {}),
      acknowledgedIssueIds,
      acknowledgedIssueCount: acknowledgedIssueIds.length,
      nonBlockingIssueCount,
    },
  };
}

/**
 * Extract entry_agent from import data if present.
 * Looks for a project.json file in the data.files map and parses it.
 */
function extractEntryAgent(data: Record<string, unknown>): string | null {
  const files = data.files as Record<string, string> | undefined;
  if (!files || typeof files !== 'object') return null;

  const projectJsonContent = files['project.json'];
  if (typeof projectJsonContent !== 'string') return null;

  try {
    const parsed = JSON.parse(projectJsonContent) as Record<string, unknown>;
    if (typeof parsed.entry_agent === 'string' && parsed.entry_agent.length > 0) {
      return parsed.entry_agent;
    }
  } catch {
    // project.json is not valid JSON — skip
  }

  return null;
}

/**
 * PATCH the project to set entryAgentName after a successful import.
 */
async function patchProjectEntryAgent(
  studioBase: string,
  headers: Record<string, string>,
  projectId: string,
  entryAgentName: string,
  dependencies: StudioApiDependencies,
): Promise<void> {
  const url = `${studioBase}/api/projects/${projectId}`;
  const response = await dependencies.fetchWithTimeout(
    url,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ entryAgentName }),
    },
    10_000,
  );
  if (!response.ok) {
    const body = sanitizeResponse(await readResponseBody(response));
    // Non-fatal: log the failure hint but don't fail the overall import
    throw new Error(
      `PATCH /api/projects/${projectId} failed: ${response.status} ${response.statusText}; body: ${JSON.stringify(body)}`,
    );
  }
}

// =============================================================================
// HANDLER
// =============================================================================

export async function platformImportExport(
  args: PlatformImportExportArgs,
  ctx: DebugContext,
  dependencies: StudioApiDependencies = defaultPlatformImportExportDependencies,
): Promise<string> {
  const { action, projectId, data, confirm } = args;
  const safeProjectId = validatePathParam(projectId, 'projectId');
  const studioBase = deriveStudioUrl(ctx.httpClient.getBaseUrl());
  const headers = buildStudioHeaders(ctx, studioBase);
  const basePath = `${studioBase}/api/projects/${safeProjectId}`;

  try {
    switch (action) {
      // ----- EXPORT PREVIEW -----
      case 'export_preview': {
        const endpointPath = `/api/projects/${safeProjectId}/export/preview`;
        const response = await dependencies.fetchWithTimeout(
          `${basePath}/export/preview`,
          { method: 'POST', headers },
          15_000,
        );
        if (!response.ok) {
          return requestFailed(response, 'POST', endpointPath);
        }
        const result = await parseJsonResponse(response);
        return success(result);
      }

      // ----- EXPORT -----
      case 'export': {
        const exportQuery = args.includeVersionHistory ? '?include_version_history=true' : '';
        const endpointPath = `/api/projects/${safeProjectId}/export${exportQuery}`;
        const response = await dependencies.fetchWithTimeout(
          `${basePath}/export${exportQuery}`,
          { headers },
          30_000,
        );
        if (!response.ok) {
          return requestFailed(response, 'GET', endpointPath);
        }
        const result = await parseJsonResponse(response);
        return success(result);
      }

      // ----- IMPORT PREVIEW -----
      case 'import_preview': {
        if (!data && !args.path && !args.files) {
          return error('data, path, or files is required for the "import_preview" action.');
        }
        const { payload, warnings, source } = await buildImportPayload(args);
        const endpointPath = `/api/projects/${safeProjectId}/import/preview`;
        const response = await dependencies.fetchWithTimeout(
          `${basePath}/import/preview`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
          },
          30_000,
        );
        if (!response.ok) {
          return requestFailed(response, 'POST', endpointPath);
        }
        const result = await parseJsonResponse(response);
        return success({
          result,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(source ? { source } : {}),
        });
      }

      // ----- IMPORT (APPLY) -----
      case 'import': {
        if (!data && !args.path && !args.files) {
          return error('data, path, or files is required for the "import" action.');
        }
        if (confirm !== true) {
          return JSON.stringify({
            success: false,
            needsConfirmation: true,
            message: 'Import will create/update/delete agents. Set confirm: true to proceed.',
          });
        }
        const { payload, warnings, source } = await buildImportPayload(args);
        const acknowledgement = await addAutomaticAcknowledgements({
          basePath,
          headers,
          safeProjectId,
          payload,
          args,
          dependencies,
        });
        if (!acknowledgement.ok) {
          return acknowledgement.response;
        }
        const endpointPath = `/api/projects/${safeProjectId}/import/apply`;
        const response = await dependencies.fetchWithTimeout(
          `${basePath}/import/apply`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(acknowledgement.payload),
          },
          30_000,
        );
        if (!response.ok) {
          return requestFailed(response, 'POST', endpointPath);
        }
        const result = await parseJsonResponse(response);

        // After successful import, update entryAgentName if present in import data
        const entryAgent = extractEntryAgent(acknowledgement.payload);
        if (entryAgent) {
          try {
            await patchProjectEntryAgent(
              studioBase,
              headers,
              safeProjectId,
              entryAgent,
              dependencies,
            );
          } catch (patchErr) {
            // Non-fatal: include a warning in the response
            const patchMessage = patchErr instanceof Error ? patchErr.message : String(patchErr);
            return JSON.stringify(
              {
                success: true,
                data: sanitizeResponse(result),
                ...(warnings.length > 0 ? { warnings } : {}),
                ...(source ? { source } : {}),
                ...(acknowledgement.autoAcknowledgement
                  ? { autoAcknowledgement: acknowledgement.autoAcknowledgement }
                  : {}),
                warning: `Import succeeded but failed to set entryAgentName: ${patchMessage}`,
              },
              null,
              2,
            );
          }
        }

        return success({
          result,
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(source ? { source } : {}),
          ...(acknowledgement.autoAcknowledgement
            ? { autoAcknowledgement: acknowledgement.autoAcknowledgement }
            : {}),
        });
      }

      default:
        return error(`Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(
      `Import/export request failed: ${message}`,
      'Import/export endpoints are served by the Studio API (port 5173). Ensure Studio is running: cd apps/studio && pnpm dev',
    );
  }
}

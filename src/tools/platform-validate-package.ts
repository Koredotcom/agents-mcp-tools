/**
 * platform_validate_package Tool
 *
 * Validates a local ABL project package by sending its file map to the
 * platform-owned package diagnostics endpoint. This supports repair loops:
 * inspect package state, analyze compiler/design issues, run evals externally,
 * patch ABL, and validate again.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { loadPackageFiles, readPackageFilesFromData } from '../utils/package-files.js';
import {
  extractPackageConstraintObservability,
  extractPackageStructuralSummary,
} from '../utils/package-contract.js';
import {
  formatStudioFailure,
  postStudioJson,
  type StudioApiDependencies,
} from '../utils/studio-api.js';
import { validatePathParam } from '../utils/validate.js';

export const platformValidatePackageSchema = z.object({
  path: z.string().optional().describe('Local project folder or .zip path to validate'),
  files: z.record(z.string()).optional().describe('Relative path -> UTF-8 file content map'),
  projectId: z
    .string()
    .optional()
    .describe(
      'Optional project ID. When provided, the tool also calls import preview to return previewDigest and acknowledgement IDs needed for apply.',
    ),
  data: z
    .record(z.unknown())
    .optional()
    .describe(
      'Optional import-preview fields such as files, layers, deleteUnmatched, or bindingResolutions.',
    ),
});

type PlatformValidatePackageArgs = z.infer<typeof platformValidatePackageSchema>;

export async function platformValidatePackage(
  args: PlatformValidatePackageArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  try {
    const loaded = await loadPackageFiles({
      path: args.path,
      files: args.files ?? readPackageFilesFromData(args.data),
    });
    const endpointPath = '/api/abl/package/validate';
    const result = await postStudioJson(
      ctx,
      endpointPath,
      { files: loaded.files },
      30_000,
      dependencies,
    );

    if (!result.ok) {
      return formatStudioFailure(endpointPath, result);
    }

    const importPreview =
      args.projectId && args.projectId.length > 0
        ? await loadImportPreview(
            ctx,
            args.projectId,
            {
              ...(args.data ?? {}),
              files: loaded.files,
            },
            dependencies,
          )
        : null;

    return JSON.stringify(
      {
        success: true,
        source: loaded.source,
        fileWarnings: loaded.warnings,
        constraintObservability: extractPackageConstraintObservability(result.body),
        structuralSummary: extractPackageStructuralSummary(result.body),
        data: result.body,
        ...(importPreview ? { importPreview } : {}),
      },
      null,
      2,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify(
      {
        success: false,
        error: `Package validation failed: ${message}`,
        hint: 'Provide path: "/absolute/project.zip", files: {"agents/example.agent.abl": "..."}, or data.files from an import payload.',
      },
      null,
      2,
    );
  }
}

async function loadImportPreview(
  ctx: DebugContext,
  projectId: string,
  payload: Record<string, unknown>,
  dependencies?: StudioApiDependencies,
): Promise<unknown> {
  const endpointPath = `/api/projects/${validatePathParam(projectId, 'projectId')}/import/preview`;
  const result = await postStudioJson(ctx, endpointPath, payload, 30_000, dependencies);
  if (!result.ok) {
    return JSON.parse(formatStudioFailure(endpointPath, result)) as unknown;
  }

  const body = isRecord(result.body) ? result.body : {};
  const preview = isRecord(body.preview) ? body.preview : null;
  const previewDigest = readString(body.previewDigest) ?? readString(preview?.previewDigest);
  const acknowledgedIssueIdsNeeded = preview ? getNonBlockingIssueIds(preview) : [];
  const blockingIssueCount = preview ? getBlockingIssueCount(preview) : undefined;
  const nonBlockingIssueCount = preview ? getNonBlockingIssueCount(preview) : undefined;
  const requiresAcknowledgement = (nonBlockingIssueCount ?? 0) > 0;
  const missingAcknowledgementIssueIdCount = Math.max(
    0,
    (nonBlockingIssueCount ?? 0) - acknowledgedIssueIdsNeeded.length,
  );
  const acknowledgementReady =
    !requiresAcknowledgement ||
    (Boolean(previewDigest) && missingAcknowledgementIssueIdCount === 0);
  const hasBlocking = preview ? hasBlockingIssues(preview) : undefined;
  return {
    success: true,
    previewDigest,
    acknowledgedIssueIdsNeeded,
    requiresAcknowledgement,
    acknowledgementReady,
    canApply: preview ? hasBlocking === false && acknowledgementReady : false,
    missingAcknowledgementIssueIdCount,
    suggestedApplyArgs:
      requiresAcknowledgement && acknowledgementReady
        ? { previewDigest, acknowledgedIssueIds: acknowledgedIssueIdsNeeded }
        : undefined,
    hasBlockingIssues: hasBlocking,
    blockingIssueCount,
    nonBlockingIssueCount,
    preview,
  };
}

function getNonBlockingIssueIds(preview: Record<string, unknown>): string[] {
  const issues = Array.isArray(preview.issues) ? preview.issues : [];
  return issues
    .map((issue) => (isRecord(issue) ? issue : null))
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
    const record = isRecord(issue) ? issue : null;
    return record?.blocking === false;
  }).length;
}

function hasBlockingIssues(preview: Record<string, unknown>): boolean {
  if (preview.hasBlockingIssues === true) {
    return true;
  }
  return getBlockingIssueCount(preview) > 0;
}

function getBlockingIssueCount(preview: Record<string, unknown>): number {
  if (typeof preview.blockingIssueCount === 'number') {
    return preview.blockingIssueCount;
  }
  const issues = Array.isArray(preview.issues) ? preview.issues : [];
  return issues.filter((issue) => {
    const record = isRecord(issue) ? issue : null;
    return record?.blocking === true;
  }).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

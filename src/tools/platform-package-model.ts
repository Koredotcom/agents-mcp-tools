/**
 * platform_package_model Tool
 *
 * Exposes the platform compiler's parsed model for agents, tools, handoffs,
 * memory variables, behavior profiles, and unresolved references.
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

export const platformPackageModelSchema = z.object({
  path: z.string().optional().describe('Local project folder or .zip path to inspect'),
  files: z.record(z.string()).optional().describe('Relative path -> UTF-8 file content map'),
  data: z
    .record(z.unknown())
    .optional()
    .describe('Optional import-style payload. data.files is accepted as the package file map.'),
});

type PlatformPackageModelArgs = z.infer<typeof platformPackageModelSchema>;

export async function platformPackageModel(
  args: PlatformPackageModelArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  try {
    const loaded = await loadPackageFiles({
      path: args.path,
      files: args.files ?? readPackageFilesFromData(args.data),
    });
    const endpointPath = '/api/abl/package/model';
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

    return JSON.stringify(
      {
        success: true,
        source: loaded.source,
        fileWarnings: loaded.warnings,
        constraintObservability: extractPackageConstraintObservability(result.body),
        structuralSummary: extractPackageStructuralSummary(result.body),
        data: result.body,
      },
      null,
      2,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify(
      { success: false, error: `Package model inspection failed: ${message}` },
      null,
      2,
    );
  }
}

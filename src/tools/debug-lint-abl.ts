/**
 * debug_lint_abl Tool
 *
 * Runs server-owned ABL repair lint checks against a local package.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { loadPackageFiles, readPackageFilesFromData } from '../utils/package-files.js';
import {
  formatStudioFailure,
  postStudioJson,
  type StudioApiDependencies,
} from '../utils/studio-api.js';

export const debugLintAblSchema = z.object({
  path: z.string().optional().describe('Local project folder or .zip path to lint'),
  files: z.record(z.string()).optional().describe('Relative path -> UTF-8 file content map'),
  data: z
    .record(z.unknown())
    .optional()
    .describe('Optional import-style payload. data.files is accepted as the package file map.'),
});

type DebugLintAblArgs = z.infer<typeof debugLintAblSchema>;

export async function debugLintAbl(
  args: DebugLintAblArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  try {
    const loaded = await loadPackageFiles({
      path: args.path,
      files: args.files ?? readPackageFilesFromData(args.data),
    });
    const endpointPath = '/api/abl/package/lint';
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
        data: result.body,
      },
      null,
      2,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ success: false, error: `ABL lint failed: ${message}` }, null, 2);
  }
}

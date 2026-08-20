/**
 * debug_why_transcript_failed Tool
 *
 * Correlates transcript symptoms with package ABL, including silent
 * finalize -> COMPLETE -> RESPOND: "" chains.
 */

import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { DebugContext } from './index.js';
import { loadPackageFiles, readPackageFilesFromData } from '../utils/package-files.js';
import {
  formatStudioFailure,
  postStudioJson,
  type StudioApiDependencies,
} from '../utils/studio-api.js';

export const debugWhyTranscriptFailedSchema = z.object({
  path: z.string().optional().describe('Local project folder or .zip path to inspect'),
  files: z.record(z.string()).optional().describe('Relative path -> UTF-8 file content map'),
  data: z
    .record(z.unknown())
    .optional()
    .describe('Optional import-style payload. data.files is accepted as the package file map.'),
  transcript: z.unknown().optional().describe('Transcript JSON object or JSON string'),
  transcriptPath: z.string().optional().describe('Local path to a transcript JSON file'),
});

type DebugWhyTranscriptFailedArgs = z.infer<typeof debugWhyTranscriptFailedSchema>;

export async function debugWhyTranscriptFailed(
  args: DebugWhyTranscriptFailedArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  try {
    const loaded = await loadPackageFiles({
      path: args.path,
      files: args.files ?? readPackageFilesFromData(args.data),
    });
    const transcript = await loadTranscript(args);
    const endpointPath = '/api/abl/package/diagnose-transcript';
    const result = await postStudioJson(
      ctx,
      endpointPath,
      {
        files: loaded.files,
        transcript,
      },
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
    return JSON.stringify(
      { success: false, error: `Transcript diagnosis failed: ${message}` },
      null,
      2,
    );
  }
}

async function loadTranscript(args: DebugWhyTranscriptFailedArgs): Promise<unknown> {
  if (args.transcript !== undefined) {
    return typeof args.transcript === 'string' ? JSON.parse(args.transcript) : args.transcript;
  }

  if (args.transcriptPath) {
    return JSON.parse(await fs.readFile(args.transcriptPath, 'utf8')) as unknown;
  }

  throw new Error('Provide transcript or transcriptPath.');
}

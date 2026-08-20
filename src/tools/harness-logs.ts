/**
 * Harness CI Log Download Tool
 *
 * Downloads and parses execution logs from Harness CI pipelines.
 * Uses the log-service blob/download API with PAT authentication.
 */

import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const ACCOUNT_ID = 'mpHRLwiFS6aJ_4tBSlMv0w';
const LOG_SERVICE_URL = 'https://app.harness.io/gateway/log-service/blob/download';

export const harnessLogsSchema = z.object({
  execution_id: z.string().describe('Pipeline execution ID (from the Harness pipeline URL)'),
  run_sequence: z.number().describe('Build number (e.g., 224, 228)'),
  pipeline_id: z.string().default('ci_build').describe('Pipeline identifier (default: ci_build)'),
  stage_id: z.string().describe('Stage identifier (e.g., build_test, docker_search_ai)'),
  step_id: z
    .string()
    .describe('Step identifier (e.g., integration_tests, unit_tests, trivy_scan, build_image)'),
  filter: z
    .string()
    .optional()
    .describe(
      'Optional regex to filter log lines (e.g., "error|fail|ECONNREFUSED"). Case-insensitive.',
    ),
  tail: z
    .number()
    .default(200)
    .describe('Number of lines to return from the end (default: 200). Ignored when filter is set.'),
});

type HarnessLogsArgs = z.infer<typeof harnessLogsSchema>;

export async function harnessLogs(args: unknown): Promise<string> {
  const parsed = harnessLogsSchema.parse(args);
  const { execution_id, run_sequence, pipeline_id, stage_id, step_id, filter, tail } = parsed;

  const apiKey = process.env.HARNESS_API_KEY;
  if (!apiKey) {
    return JSON.stringify({
      error: 'HARNESS_API_KEY environment variable is not set',
      hint: 'Set it with: export HARNESS_API_KEY="pat.xxx..."',
    });
  }

  // Build the prefix path (execution_id gets a leading dash)
  const prefix = `${ACCOUNT_ID}/pipeline/${pipeline_id}/${run_sequence}/-${execution_id}/${stage_id}/${step_id}`;
  const encodedPrefix = encodeURIComponent(prefix);
  const url = `${LOG_SERVICE_URL}?accountID=${ACCOUNT_ID}&prefix=${encodedPrefix}`;

  try {
    // Step 1: Get download link
    const linkResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
      },
    });

    if (!linkResponse.ok) {
      return JSON.stringify({
        error: `Failed to get log download link: HTTP ${linkResponse.status}`,
        body: await linkResponse.text(),
      });
    }

    const linkData = (await linkResponse.json()) as { link?: string; status?: string };
    if (!linkData.link) {
      return JSON.stringify({
        error: 'No download link returned',
        response: linkData,
      });
    }

    // Step 2: Download the zip
    const zipResponse = await fetch(linkData.link);
    if (!zipResponse.ok) {
      return JSON.stringify({
        error: `Failed to download logs: HTTP ${zipResponse.status}`,
      });
    }

    const zipBuffer = Buffer.from(await zipResponse.arrayBuffer());
    const tmpPath = join(tmpdir(), `harness-logs-${Date.now()}.zip`);
    await writeFile(tmpPath, zipBuffer);

    try {
      // Step 3: Extract and parse
      const { stdout: rawLogs } = await execFileAsync('unzip', ['-p', tmpPath], {
        maxBuffer: 50 * 1024 * 1024, // 50MB
      });

      const lines = rawLogs.split('\n').filter((l) => l.trim());
      const parsed_lines: { time: string; level: string; text: string }[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { out?: string; level?: string; time?: string };
          const text = (entry.out ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (text) {
            parsed_lines.push({
              time: (entry.time ?? '').slice(0, 19),
              level: entry.level ?? 'info',
              text,
            });
          }
        } catch {
          if (line.trim()) {
            parsed_lines.push({ time: '', level: 'raw', text: line.trim() });
          }
        }
      }

      let result_lines: typeof parsed_lines;

      if (filter) {
        const regex = new RegExp(filter, 'i');
        result_lines = parsed_lines.filter((l) => regex.test(l.text));
      } else {
        result_lines = parsed_lines.slice(-tail);
      }

      const output = result_lines.map((l) => `[${l.time}] [${l.level}] ${l.text}`).join('\n');

      return JSON.stringify({
        execution_id,
        run_sequence,
        stage: `${stage_id}/${step_id}`,
        total_lines: parsed_lines.length,
        returned_lines: result_lines.length,
        filter: filter ?? null,
        logs: output,
      });
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `Log download failed: ${message}` });
  }
}

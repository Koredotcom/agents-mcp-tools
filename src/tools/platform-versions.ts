/** Manage immutable agent versions through the current Runtime contracts. */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DebugContext } from './index.js';
import { validatePathParam } from '../utils/validate.js';
import { sanitizeResponse } from '../utils/sanitize.js';

const versionValue = z.union([z.string().min(1), z.number().nonnegative()]);

export const platformVersionsSchema = z.object({
  action: z.enum([
    'list',
    'create',
    'get',
    'promote',
    'diff',
    'publish',
    'qualifications',
    'audit',
  ]),
  projectId: z.string().describe('Project ID'),
  agentName: z.string().describe('Agent name'),
  version: versionValue.optional().describe('Published semantic version'),
  otherVersion: versionValue.optional().describe('Other version for diff'),
  status: z.string().optional().describe('Legacy promote status (unsupported)'),
  changelog: z.string().optional().describe('Changelog for publish'),
  publishMode: z.enum(['manual', 'auto']).optional().describe('Publish mode'),
  expectedDraftSourceHash: z
    .string()
    .min(1)
    .optional()
    .describe('Authoritative working-copy source hash; derived from the agent when omitted'),
  limit: z.number().int().positive().max(100).optional().describe('Bounded read limit'),
});

export type PlatformVersionsArgs = z.infer<typeof platformVersionsSchema>;

function result(success: boolean, value: Record<string, unknown>): string {
  return JSON.stringify({ success, ...value }, null, 2);
}

function requireVersion(version: string | number | undefined, action: string): string | null {
  return version === undefined
    ? result(false, { error: `version is required for the ${action} action.` })
    : null;
}

function versionString(version: string | number): string {
  return String(version);
}

function draftSourceHashFromAgentResponse(response: unknown): string {
  if (typeof response !== 'object' || response === null) {
    return createHash('sha256').update('', 'utf8').digest('hex');
  }
  const root = response as Record<string, unknown>;
  const agent =
    typeof root.agent === 'object' && root.agent !== null
      ? (root.agent as Record<string, unknown>)
      : root;
  if (typeof agent.sourceHash === 'string' && agent.sourceHash.length > 0) {
    return agent.sourceHash;
  }
  const dslContent = typeof agent.dslContent === 'string' ? agent.dslContent : '';
  return createHash('sha256').update(dslContent, 'utf8').digest('hex');
}

export async function platformVersions(
  args: PlatformVersionsArgs,
  ctx: DebugContext,
): Promise<string> {
  const { action, projectId, agentName } = args;
  const safeProjectId = validatePathParam(projectId, 'projectId');
  const safeAgentName = validatePathParam(agentName, 'agentName');
  const basePath = `/api/projects/${safeProjectId}/agents/${safeAgentName}/versions`;

  try {
    if (action === 'create') {
      return result(false, {
        code: 'LEGACY_ACTION_UNSUPPORTED',
        error: 'Version create is obsolete because it lacks the draft hash guard.',
        successor: 'Use action="publish".',
      });
    }
    if (action === 'promote') {
      return result(false, {
        code: 'LEGACY_ACTION_UNSUPPORTED',
        error: 'Version-level promote is obsolete.',
        successor: 'Use platform_deployments action="promote".',
      });
    }
    if (action === 'list') {
      const data = await ctx.httpClient.get(basePath);
      return result(true, { data: sanitizeResponse(data) });
    }
    if (action === 'publish') {
      let expectedDraftSourceHash = args.expectedDraftSourceHash;
      if (!expectedDraftSourceHash) {
        const agent = await ctx.httpClient.get(
          `/api/projects/${safeProjectId}/agents/${safeAgentName}`,
        );
        expectedDraftSourceHash = draftSourceHashFromAgentResponse(agent);
      }
      const body = {
        ...(args.version !== undefined ? { version: versionString(args.version) } : {}),
        ...(args.changelog !== undefined ? { changelog: args.changelog } : {}),
        expectedDraftSourceHash,
        ...(args.publishMode ? { publishMode: args.publishMode } : {}),
      };
      const data = await ctx.httpClient.post(`${basePath}/publish`, body);
      return result(true, { data: sanitizeResponse(data) });
    }

    const missing = requireVersion(args.version, action);
    if (missing) return missing;
    const version = validatePathParam(versionString(args.version!), 'version');
    if (action === 'get') {
      const data = await ctx.httpClient.get(`${basePath}/${version}`);
      return result(true, { data: sanitizeResponse(data) });
    }
    if (action === 'qualifications' || action === 'audit') {
      const limit = args.limit ?? 100;
      const data = await ctx.httpClient.get(`${basePath}/${version}/${action}?limit=${limit}`);
      return result(true, { data: sanitizeResponse(data) });
    }
    if (args.otherVersion === undefined) {
      return result(false, { error: 'otherVersion is required for the diff action.' });
    }
    const other = validatePathParam(versionString(args.otherVersion), 'otherVersion');
    const data = await ctx.httpClient.get(`${basePath}/${version}/diff/${other}`);
    return result(true, { data: sanitizeResponse(data) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result(false, {
      error: `platform_versions ${action} failed: ${message}`,
      hint: 'Ensure the runtime is running and you are connected (platform_connect).',
    });
  }
}

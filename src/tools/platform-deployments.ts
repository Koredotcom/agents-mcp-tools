/** Manage deployments through the current typed Runtime lifecycle contracts. */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { validatePathParam } from '../utils/validate.js';
import { sanitizeResponse } from '../utils/sanitize.js';

export const platformManifestEntrySchema = z
  .object({
    version: z.string().min(1),
    configVarsVersion: z.string().min(1).optional(),
    configVarsVersionLabel: z.string().min(1).optional(),
    settingsVersion: z.string().min(1).optional(),
  })
  .strict();

const environmentSchema = z.enum(['dev', 'staging', 'production']);

export const platformDeploymentsSchema = z.object({
  action: z.enum(['list', 'create', 'get', 'promote', 'retire', 'rollback', 'restore']),
  projectId: z.string().describe('Project ID'),
  deploymentId: z.string().optional().describe('Deployment ID'),
  label: z.string().optional().describe('Deployment label'),
  description: z.string().optional().describe('Deployment description'),
  environment: environmentSchema.optional().describe('Environment for create'),
  targetEnvironment: environmentSchema.optional().describe('Target environment for promote'),
  entryAgentName: z.string().optional().describe('Entry agent (empty for workflow-only)'),
  agentVersionManifest: z
    .record(platformManifestEntrySchema)
    .optional()
    .describe('Typed map of agent names to immutable versions'),
  workflowVersionManifest: z
    .record(platformManifestEntrySchema)
    .optional()
    .describe('Typed map of workflow names to immutable versions'),
  modelOverrides: z.record(z.record(z.unknown())).optional(),
  settingsVersionId: z.string().min(1).optional(),
  deploymentConfigVarsVersion: z.string().min(1).optional(),
  force: z.boolean().optional().describe('Create without preflight or retire immediately'),
  bypassQualificationGate: z.boolean().optional(),
  bypassReason: z.string().trim().min(1).optional(),
  confirm: z.boolean().optional().describe('Required for rollback, restore, and retire'),
});

export type PlatformDeploymentsArgs = z.infer<typeof platformDeploymentsSchema>;

function result(success: boolean, value: Record<string, unknown>): string {
  return JSON.stringify({ success, ...value }, null, 2);
}

function requireDeploymentId(value: string | undefined, action: string): string | null {
  return value
    ? null
    : result(false, { error: `deploymentId is required for the ${action} action.` });
}

function bypassBody(args: PlatformDeploymentsArgs): Record<string, unknown> {
  return args.bypassQualificationGate
    ? { bypassQualificationGate: true, bypassReason: args.bypassReason }
    : {};
}

function validateBypass(args: PlatformDeploymentsArgs): string | null {
  return args.bypassQualificationGate && !args.bypassReason?.trim()
    ? result(false, {
        code: 'CONFIRMATION_REQUIRED',
        error: 'Qualification bypass requires bypassQualificationGate=true and bypassReason.',
      })
    : null;
}

export async function platformDeployments(
  args: PlatformDeploymentsArgs,
  ctx: DebugContext,
): Promise<string> {
  const { action, projectId } = args;
  const safeProjectId = validatePathParam(projectId, 'projectId');
  const basePath = `/api/projects/${safeProjectId}/deployments`;

  try {
    if (action === 'list') {
      const data = await ctx.httpClient.get(basePath);
      return result(true, { data: sanitizeResponse(data) });
    }
    if (action === 'create') {
      if (!args.environment) return result(false, { error: 'environment is required for create.' });
      if (args.entryAgentName === undefined) {
        return result(false, { error: 'entryAgentName is required for create.' });
      }
      if (!args.agentVersionManifest) {
        return result(false, { error: 'agentVersionManifest is required for create.' });
      }
      if (
        Object.keys(args.agentVersionManifest).length === 0 &&
        Object.keys(args.workflowVersionManifest ?? {}).length === 0
      ) {
        return result(false, {
          error: 'At least one typed manifest entry is required for create.',
        });
      }
      const bypassError = validateBypass(args);
      if (bypassError) return bypassError;
      const data = await ctx.httpClient.post(basePath, {
        environment: args.environment,
        entryAgentName: args.entryAgentName,
        agentVersionManifest: args.agentVersionManifest,
        ...(args.workflowVersionManifest
          ? { workflowVersionManifest: args.workflowVersionManifest }
          : {}),
        ...(args.label ? { label: args.label } : {}),
        ...(args.description ? { description: args.description } : {}),
        ...(args.modelOverrides ? { modelOverrides: args.modelOverrides } : {}),
        ...(args.settingsVersionId ? { settingsVersionId: args.settingsVersionId } : {}),
        ...(args.deploymentConfigVarsVersion
          ? { deploymentConfigVarsVersion: args.deploymentConfigVarsVersion }
          : {}),
        ...(args.force ? { force: true } : {}),
        ...bypassBody(args),
      });
      return result(true, { data: sanitizeResponse(data) });
    }

    const missingId = requireDeploymentId(args.deploymentId, action);
    if (missingId) return missingId;
    const deploymentId = validatePathParam(args.deploymentId!, 'deploymentId');
    const deploymentPath = `${basePath}/${deploymentId}`;
    if (action === 'get') {
      const data = await ctx.httpClient.get(deploymentPath);
      return result(true, { data: sanitizeResponse(data) });
    }
    if (action === 'rollback' || action === 'restore' || action === 'retire') {
      if (args.confirm !== true) {
        return result(false, {
          code: 'CONFIRMATION_REQUIRED',
          needsConfirmation: true,
          error: `Set confirm=true to ${action} this deployment.`,
        });
      }
    }
    if (action === 'retire') {
      const data = await ctx.httpClient.post(`${deploymentPath}/retire`, {
        ...(args.force ? { force: true } : {}),
      });
      return result(true, { data: sanitizeResponse(data) });
    }
    const bypassError = validateBypass(args);
    if (bypassError) return bypassError;
    if (action === 'promote') {
      if (!args.targetEnvironment) {
        return result(false, { error: 'targetEnvironment is required for promote.' });
      }
      const data = await ctx.httpClient.post(`${deploymentPath}/promote`, {
        targetEnvironment: args.targetEnvironment,
        ...(args.label ? { label: args.label } : {}),
        ...(args.description ? { description: args.description } : {}),
        ...(args.modelOverrides ? { modelOverrides: args.modelOverrides } : {}),
        ...bypassBody(args),
      });
      return result(true, { data: sanitizeResponse(data) });
    }
    const data = await ctx.httpClient.post(`${deploymentPath}/${action}`, bypassBody(args));
    return result(true, { data: sanitizeResponse(data) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result(false, {
      error: `platform_deployments ${action} failed: ${message}`,
      hint: 'Ensure the runtime is running and you are connected (platform_connect).',
    });
  }
}

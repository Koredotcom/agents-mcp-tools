/** Project-scoped auth profile management for the published Arch MCP server. */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import {
  formatStudioFailure,
  requestStudioJson,
  type StudioApiDependencies,
} from '../utils/studio-api.js';
import { validatePathParam } from '../utils/validate.js';
import { findSensitiveFieldPath, sanitizeResponse } from '../utils/sanitize.js';

const AUTH_PROFILE_TIMEOUT_MS = 15_000;

export const platformAuthProfilesSchema = z.object({
  action: z.enum([
    'list',
    'get',
    'create',
    'update',
    'validate',
    'revoke',
    'delete',
    'providers',
    'integrations',
    'oauth_initiate',
  ]),
  projectId: z.string().min(1).describe('Project ID'),
  profileId: z.string().min(1).optional().describe('Auth profile ID'),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  authType: z.string().min(1).optional(),
  scope: z.enum(['tenant', 'project']).optional(),
  visibility: z.enum(['shared', 'personal']).optional(),
  connectionMode: z.enum(['shared', 'per_user']).optional(),
  usageMode: z.enum(['preconfigured', 'user_token', 'jit', 'preflight']).optional(),
  environment: z.string().nullable().optional(),
  connector: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  config: z
    .record(z.unknown())
    .optional()
    .describe('Non-secret auth configuration. Raw credentials are rejected.'),
  connectionConfig: z
    .record(z.string())
    .optional()
    .describe('Non-secret OAuth URL template values used by oauth_initiate.'),
  authProfileRef: z.string().min(1).optional(),
  isUserConsent: z.boolean().optional(),
  cursor: z.string().min(1).optional().describe('Cursor returned by a previous list response'),
  limit: z.number().int().min(1).max(500).optional().describe('Maximum list results'),
  search: z.string().min(1).optional().describe('Auth profile name search for list'),
  confirm: z.boolean().optional().describe('Required for delete and revoke'),
});

export type PlatformAuthProfilesArgs = z.infer<typeof platformAuthProfilesSchema>;

function error(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(sanitizeResponse({ success: false, error: message, ...extra }));
}

function requireField(value: string | undefined, field: string, action: string): string | null {
  return value ? null : `${field} is required for the ${action} action.`;
}

function profileBody(
  args: PlatformAuthProfilesArgs,
  includeRequired: boolean,
): Record<string, unknown> {
  return {
    ...(includeRequired ? { name: args.name, authType: args.authType, secrets: {} } : {}),
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.config !== undefined ? { config: args.config } : {}),
    ...(includeRequired ? { scope: args.scope ?? 'project' } : {}),
    ...(includeRequired ? { projectId: args.scope === 'tenant' ? null : args.projectId } : {}),
    ...(args.visibility !== undefined ? { visibility: args.visibility } : {}),
    ...(args.connectionMode !== undefined ? { connectionMode: args.connectionMode } : {}),
    ...(args.usageMode !== undefined ? { usageMode: args.usageMode } : {}),
    ...(args.environment !== undefined ? { environment: args.environment } : {}),
    ...(args.connector !== undefined ? { connector: args.connector } : {}),
    ...(args.category !== undefined ? { category: args.category } : {}),
    ...(args.tags !== undefined ? { tags: args.tags } : {}),
    ...(!includeRequired && args.enabled !== undefined ? { enabled: args.enabled } : {}),
  };
}

export async function platformAuthProfiles(
  args: PlatformAuthProfilesArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  const safeProjectId = validatePathParam(args.projectId, 'projectId');
  const basePath = `/api/projects/${safeProjectId}/auth-profiles`;
  const profilePath = args.profileId
    ? `${basePath}/${validatePathParam(args.profileId, 'profileId')}`
    : null;

  const unsafePath = findSensitiveFieldPath(args);
  if (unsafePath) {
    return error(`Raw credential field "${unsafePath}" is not allowed in MCP arguments.`, {
      nextAction:
        'Create the profile metadata first, then complete secret or OAuth setup in the secure Studio auth flow.',
    });
  }

  let method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET';
  let path = basePath;
  let body: unknown;

  switch (args.action) {
    case 'list':
      {
        const query = new URLSearchParams();
        if (args.cursor) query.set('cursor', args.cursor);
        if (args.limit !== undefined) query.set('limit', String(args.limit));
        if (args.search) query.set('search', args.search);
        if (args.authType) query.append('authType', args.authType);
        if (args.connector) query.set('connector', args.connector);
        if (args.environment) query.set('environment', args.environment);
        if (args.scope) query.set('scope', args.scope);
        path = query.size > 0 ? `${basePath}?${query}` : basePath;
      }
      break;
    case 'get':
      if (!profilePath) return error(requireField(args.profileId, 'profileId', args.action)!);
      path = profilePath;
      break;
    case 'create': {
      const missing =
        requireField(args.name, 'name', args.action) ??
        requireField(args.authType, 'authType', args.action);
      if (missing) return error(missing);
      if (args.scope === 'tenant') {
        return error(
          'platform_auth_profiles is project-scoped and cannot create tenant profiles.',
          {
            secureSetupRequired: true,
            nextAction:
              'Create tenant-scoped auth profiles in the secure Studio administration flow.',
          },
        );
      }
      if (args.authType !== 'none') {
        return error(
          `Creating authType "${args.authType}" requires credential material that must not enter MCP or model context.`,
          {
            secureSetupRequired: true,
            studioPath: `/projects/${safeProjectId}/auth-profiles`,
            nextAction:
              'Create the credential-bearing profile in Studio, then use list/get/oauth_initiate from this tool and reference its ID from integrations, tools, or MCP servers.',
          },
        );
      }
      if (args.config && Object.keys(args.config).length > 0) {
        return error('authType "none" only accepts an empty config object.');
      }
      method = 'POST';
      body = {
        ...profileBody(args, true),
        config: {},
        scope: 'project',
        projectId: args.projectId,
      };
      break;
    }
    case 'update':
      if (!profilePath) return error(requireField(args.profileId, 'profileId', args.action)!);
      method = 'PUT';
      path = profilePath;
      body = profileBody(args, false);
      if (Object.keys(body as Record<string, unknown>).length === 0) {
        return error('At least one metadata field is required for the update action.');
      }
      break;
    case 'validate':
      if (!profilePath) return error(requireField(args.profileId, 'profileId', args.action)!);
      method = 'POST';
      path = `${profilePath}/validate`;
      break;
    case 'revoke':
      if (!profilePath) return error(requireField(args.profileId, 'profileId', args.action)!);
      if (args.confirm !== true) {
        return error('Revoking an auth profile requires confirm: true.', {
          needsConfirmation: true,
        });
      }
      method = 'POST';
      path = `${profilePath}/revoke`;
      break;
    case 'delete':
      if (!profilePath) return error(requireField(args.profileId, 'profileId', args.action)!);
      if (args.confirm !== true) {
        return error('Deleting an auth profile requires confirm: true.', {
          needsConfirmation: true,
        });
      }
      method = 'DELETE';
      path = `${profilePath}?confirm=true`;
      break;
    case 'providers':
      path = `${basePath}/providers`;
      break;
    case 'integrations':
      path = `${basePath}/integrations`;
      break;
    case 'oauth_initiate': {
      if (args.profileId && args.authProfileRef) {
        return error(
          'Provide exactly one of profileId or authProfileRef for the oauth_initiate action.',
        );
      }
      const reference = args.profileId ?? args.authProfileRef;
      if (!reference) {
        return error('profileId or authProfileRef is required for the oauth_initiate action.');
      }
      method = 'POST';
      path = `${basePath}/oauth/initiate`;
      body = {
        ...(args.profileId ? { authProfileId: args.profileId } : {}),
        ...(args.authProfileRef ? { authProfileRef: args.authProfileRef } : {}),
        ...(args.connector ? { connectorName: args.connector } : {}),
        ...(args.environment !== undefined ? { environment: args.environment } : {}),
        ...(args.isUserConsent !== undefined ? { isUserConsent: args.isUserConsent } : {}),
        ...(args.connectionConfig ? { connectionConfig: args.connectionConfig } : {}),
      };
      break;
    }
  }

  try {
    const result = await requestStudioJson(
      ctx,
      { method, path, ...(body !== undefined ? { body } : {}), timeoutMs: AUTH_PROFILE_TIMEOUT_MS },
      dependencies,
    );
    return result.ok
      ? JSON.stringify(result.body, null, 2)
      : formatStudioFailure(path, result, method);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(`platform_auth_profiles ${args.action} failed: ${message}`);
  }
}

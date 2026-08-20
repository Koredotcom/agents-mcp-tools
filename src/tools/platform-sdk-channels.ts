/** Manage the public-key and SDK-channel bootstrap surface used by packaged clients. */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { validatePathParam } from '../utils/validate.js';
import { findSensitiveFieldPath, sanitizeResponse } from '../utils/sanitize.js';

export const platformSdkChannelsSchema = z.object({
  action: z.enum(['list_keys', 'create_key', 'list_channels', 'create_channel']),
  projectId: z.string().describe('Project ID'),
  name: z.string().min(1).max(100).optional().describe('Key or channel name for create actions'),
  allowedOrigins: z.array(z.string().url()).max(50).optional(),
  permissions: z.object({ chat: z.boolean().optional(), voice: z.boolean().optional() }).optional(),
  channelType: z
    .enum(['web', 'mobile_ios', 'mobile_android', 'api'])
    .optional()
    .describe('SDK channel type (for create_channel)'),
  publicApiKeyId: z.string().optional().describe('SDK public key ID (for create_channel)'),
  environment: z
    .enum(['dev', 'staging', 'production'])
    .optional()
    .describe('Deployment environment followed by the channel'),
  authMode: z.enum(['anonymous', 'hosted_exchange']).optional(),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum SDK channels to list'),
  offset: z.number().int().nonnegative().optional().describe('SDK channel list offset'),
});

type PlatformSdkChannelsArgs = z.infer<typeof platformSdkChannelsSchema>;

function result(data: unknown): string {
  return JSON.stringify({ success: true, data: sanitizeResponse(data) }, null, 2);
}

function failure(message: string): string {
  return JSON.stringify(sanitizeResponse({ success: false, error: message }));
}

export async function platformSdkChannels(
  args: PlatformSdkChannelsArgs,
  ctx: DebugContext,
): Promise<string> {
  const unsafePath = findSensitiveFieldPath(args);
  if (unsafePath) {
    return failure(`Raw credential field "${unsafePath}" is not allowed in MCP arguments.`);
  }
  const safeProjectId = validatePathParam(args.projectId, 'projectId');
  const keysPath = `/api/projects/${safeProjectId}/sdk-public-keys`;
  const channelsPath = `/api/projects/${safeProjectId}/sdk-channels`;

  try {
    switch (args.action) {
      case 'list_keys':
        return result(await ctx.httpClient.get(keysPath));
      case 'create_key': {
        if (!args.name) return failure('name is required for create_key.');
        return result(
          await ctx.httpClient.post(keysPath, {
            name: args.name,
            ...(args.allowedOrigins ? { allowedOrigins: args.allowedOrigins } : {}),
            ...(args.permissions ? { permissions: args.permissions } : {}),
          }),
        );
      }
      case 'list_channels': {
        const query = new URLSearchParams();
        if (args.limit !== undefined) query.set('limit', String(args.limit));
        if (args.offset !== undefined) query.set('offset', String(args.offset));
        const path = query.size > 0 ? `${channelsPath}?${query}` : channelsPath;
        return result(await ctx.httpClient.get(path));
      }
      case 'create_channel': {
        if (!args.name) return failure('name is required for create_channel.');
        if (!args.channelType) return failure('channelType is required for create_channel.');
        if (!args.publicApiKeyId) {
          return failure('publicApiKeyId is required for create_channel.');
        }
        return result(
          await ctx.httpClient.post(channelsPath, {
            name: args.name,
            channelType: args.channelType,
            publicApiKeyId: args.publicApiKeyId,
            environment: args.environment ?? 'dev',
            auth: { mode: args.authMode ?? 'anonymous' },
            ...(args.allowedOrigins ? { allowedOrigins: args.allowedOrigins } : {}),
          }),
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`platform_sdk_channels ${args.action} failed: ${message}`);
  }
}

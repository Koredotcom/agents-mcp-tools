/**
 * platform_arch_sop Tool
 *
 * Thin MCP wrapper over Studio-owned Arch SOP/session APIs. Keep this package
 * standalone: Studio owns the Arch build semantics, MCP only forwards the
 * public HTTP contract with same-origin auth headers.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import {
  requestStudioJson,
  formatStudioFailure,
  type StudioApiDependencies,
} from '../utils/studio-api.js';
import { sanitizeResponse } from '../utils/sanitize.js';
import { validatePathParam } from '../utils/validate.js';

const bodySchema = z.record(z.unknown()).optional();
const fileRefSchema = z.object({
  blobId: z.string().min(1),
});
const uploadFileSchema = z.object({
  name: z.string().min(1),
  type: z.string().default(''),
  size: z.number().positive(),
  content: z.string().min(1).describe('Base64-encoded file content'),
});

export const platformArchSopSchema = z.object({
  action: z.enum([
    'create_session',
    'get_session',
    'upload_file',
    'send_message',
    'continue',
    'create_project',
    'recover',
    'cancel',
  ]),
  sessionId: z.string().optional().describe('Arch session ID for session-scoped actions'),
  projectId: z.string().optional().describe('Project ID for in-project Arch sessions'),
  text: z.string().optional().describe('Message text for send_message'),
  fileRefs: z.array(fileRefSchema).optional().describe('Uploaded file blob refs for send_message'),
  file: uploadFileSchema.optional().describe('File payload for upload_file'),
  body: bodySchema.describe(
    'Raw Studio request body override for advanced Arch session/message calls',
  ),
  forceNew: z
    .boolean()
    .optional()
    .describe('Create a fresh session instead of reusing a visible one'),
  force: z
    .boolean()
    .optional()
    .describe('Force session creation/recovery where the Studio API supports it'),
  surface: z.enum(['project', 'agent-editor']).optional().describe('In-project Arch surface'),
  agentName: z.string().optional().describe('Agent editor target when surface is agent-editor'),
  threadId: z.string().optional().describe('Arch thread ID for scoped session reuse'),
});

type PlatformArchSopArgs = z.infer<typeof platformArchSopSchema>;

export async function platformArchSop(
  args: PlatformArchSopArgs,
  ctx: DebugContext,
  dependencies?: StudioApiDependencies,
): Promise<string> {
  try {
    switch (args.action) {
      case 'create_session':
        return studioRequest(
          ctx,
          'POST',
          '/api/arch-ai/sessions',
          buildCreateSessionBody(args),
          dependencies,
        );
      case 'get_session':
        return studioRequest(
          ctx,
          'GET',
          `/api/arch-ai/sessions/${requirePathId(args.sessionId, 'sessionId')}`,
          undefined,
          dependencies,
        );
      case 'upload_file':
        return studioRequest(
          ctx,
          'POST',
          '/api/arch-ai/files',
          buildUploadFileBody(args),
          dependencies,
          60_000,
        );
      case 'send_message':
        return studioRequest(
          ctx,
          'POST',
          '/api/arch-ai/message',
          buildMessageBody(args),
          dependencies,
          120_000,
        );
      case 'continue':
        return studioRequest(
          ctx,
          'POST',
          '/api/arch-ai/message',
          { sessionId: requireBodyId(args.sessionId, 'sessionId'), type: 'continue' },
          dependencies,
          120_000,
        );
      case 'create_project':
        return studioRequest(
          ctx,
          'POST',
          '/api/arch-ai/message',
          { sessionId: requireBodyId(args.sessionId, 'sessionId'), type: 'create' },
          dependencies,
          120_000,
        );
      case 'recover':
        return studioRequest(
          ctx,
          'POST',
          `/api/arch-ai/sessions/${requirePathId(args.sessionId, 'sessionId')}/recover`,
          args.body ?? {},
          dependencies,
        );
      case 'cancel':
        return studioRequest(
          ctx,
          'POST',
          `/api/arch-ai/sessions/${requirePathId(args.sessionId, 'sessionId')}/cancel`,
          args.body ?? {},
          dependencies,
        );
    }
  } catch (err) {
    return jsonError(err);
  }
}

function buildCreateSessionBody(args: PlatformArchSopArgs): Record<string, unknown> {
  if (args.body) return args.body;

  const body: Record<string, unknown> = {};
  if (args.projectId) body.projectId = args.projectId;
  if (args.forceNew !== undefined) body.forceNew = args.forceNew;
  if (args.force !== undefined) body.force = args.force;
  if (args.surface !== undefined) body.surface = args.surface;
  if (args.agentName !== undefined) body.agentName = args.agentName;
  if (args.threadId !== undefined) body.threadId = args.threadId;
  return body;
}

function buildUploadFileBody(args: PlatformArchSopArgs): Record<string, unknown> {
  if (args.body) return args.body;
  if (!args.file) {
    throw new Error('file is required for upload_file when body is not provided.');
  }
  return {
    sessionId: requireBodyId(args.sessionId, 'sessionId'),
    file: args.file,
  };
}

function buildMessageBody(args: PlatformArchSopArgs): Record<string, unknown> {
  if (args.body) return args.body;
  const sessionId = requireBodyId(args.sessionId, 'sessionId');
  if (!args.text || args.text.trim().length === 0) {
    const hasFileRefs = (args.fileRefs?.length ?? 0) > 0;
    if (!hasFileRefs) {
      throw new Error('text or fileRefs is required for send_message when body is not provided.');
    }
  }
  const body: Record<string, unknown> = {
    sessionId,
    type: 'message',
    text: args.text ?? '',
  };
  if (args.fileRefs) body.fileRefs = args.fileRefs;
  return body;
}

function requirePathId(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required for this action.`);
  }
  return validatePathParam(value, name);
}

function requireBodyId(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required for this action.`);
  }
  if (/[\/\\]|\.\.|%2[fF]|%5[cC]|%2[eE]/.test(value)) {
    throw new Error(`Invalid ${name}: must not contain path separators or traversal sequences`);
  }
  return value;
}

async function studioRequest(
  ctx: DebugContext,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  dependencies?: StudioApiDependencies,
  timeoutMs?: number,
): Promise<string> {
  const result = await requestStudioJson(
    ctx,
    {
      method,
      path,
      ...(body !== undefined ? { body } : {}),
      timeoutMs: timeoutMs ?? (method === 'GET' ? 15_000 : 30_000),
    },
    dependencies,
  );

  if (!result.ok) {
    return formatStudioFailure(path, result, method);
  }

  return JSON.stringify({ success: true, data: sanitizeResponse(result.body) }, null, 2);
}

function jsonError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return JSON.stringify({ success: false, error: message }, null, 2);
}

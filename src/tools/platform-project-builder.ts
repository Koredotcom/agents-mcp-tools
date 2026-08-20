import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import type { DebugContext } from './index.js';
import {
  createProjectBuilderResult,
  type JsonSchema,
  type ProjectBuilderDomainRegistry,
  type ProjectBuilderToolResult,
} from '../project-building/contracts.js';
import { createProductionProjectBuilderDomainRegistry } from '../project-building/domain-registry.js';
import { requestProjectBuilderStudio } from '../project-building/studio-transport.js';
import type { ProjectBuilderStudioTransportDependencies } from '../project-building/studio-transport.js';

const domainSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
const boundedInputSchema = z.record(z.unknown()).optional();
const operationListInputSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    status: z.string().min(1).optional(),
    stage: z.string().min(1).optional(),
  })
  .strict()
  .optional();

export const platformProjectBuilderSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('describe'), domain: domainSchema.optional() }).strict(),
  z
    .object({
      action: z.literal('inspect'),
      domain: z.literal('project'),
      projectId: z.string().min(1),
      domains: z.array(domainSchema).min(1).max(16).optional(),
      includeReadiness: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('plan'),
      domain: domainSchema.default('workflow'),
      projectId: z.string().min(1),
      input: boundedInputSchema,
    })
    .strict(),
]);

export const platformProjectOperationsSchema = z.discriminatedUnion('action', [
  operationSchema('list', false, operationListInputSchema),
  operationSchema('read', true),
  operationSchema('dependency_report', true),
  operationSchema('readiness_report', true),
  operationSchema('resume', true),
  operationSchema('cancel', true),
  operationSchema('create_confirmation_grant', true),
  operationSchema('execute_action', true),
]);

export const PROJECT_BUILDER_OUTPUT_SCHEMA: JsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'action', 'success', 'data', 'error'],
  properties: {
    schemaVersion: { const: '1.1' },
    action: { type: 'string' },
    success: { type: 'boolean' },
    data: {},
    error: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['code', 'message', 'retryable', 'nextActions'],
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            retryable: { type: 'boolean' },
            nextActions: { type: 'array' },
          },
        },
      ],
    },
  },
});

export const PROJECT_BUILDER_TOOL_ANNOTATIONS: ToolAnnotations = Object.freeze({
  title: 'Arch Project Builder',
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});

export const PROJECT_OPERATIONS_TOOL_ANNOTATIONS: ToolAnnotations = Object.freeze({
  title: 'Arch Project Operations',
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
});

type PlatformProjectBuilderArgs = z.infer<typeof platformProjectBuilderSchema>;
type PlatformProjectOperationsArgs = z.infer<typeof platformProjectOperationsSchema>;

export async function platformProjectBuilder(
  args: PlatformProjectBuilderArgs,
  ctx: DebugContext,
  dependencies?: ProjectBuilderStudioTransportDependencies,
): Promise<ProjectBuilderToolResult> {
  const registry = resolveRegistry(ctx);
  const transportDependencies = dependencies ?? ctx.projectBuilderTransportDependencies;
  if (args.action === 'describe') {
    if (!args.domain) return createProjectBuilderResult('describe', registry.describe());
    const provider = registry.getProvider(args.domain);
    return createProjectBuilderResult('describe', {
      ...registry.describe(args.domain),
      ontology: provider.ontology,
      actions: provider.actions,
      inputSchemas: provider.inputSchemas,
      outputSchemas: provider.outputSchemas,
      readinessOwner: provider.readinessOwner,
    });
  }
  if (args.action === 'inspect') {
    const domains = [...(args.domains ?? registry.providers.map(({ domain }) => domain))].sort();
    for (const domain of domains) registry.getProvider(domain);
    const query = new URLSearchParams({
      domains: domains.join(','),
      includeReadiness: String(args.includeReadiness ?? true),
    });
    return requestProjectBuilderStudio(
      ctx,
      {
        action: 'inspect',
        domain: domains,
        route: {
          method: 'GET',
          path: `/api/projects/${encodeURIComponent(args.projectId)}/arch-project-builder/dependency-report?${query}`,
        },
        timeoutMs: 30_000,
      },
      transportDependencies,
    );
  }

  const provider = registry.getProvider(args.domain);
  return requestProjectBuilderStudio(
    ctx,
    {
      action: 'plan',
      domain: provider.domain,
      route: provider.routeAdapter.buildRequest('plan', {
        projectId: args.projectId,
        input: args.input,
      }),
      timeoutMs: 30_000,
    },
    transportDependencies,
  );
}

export async function platformProjectOperations(
  args: PlatformProjectOperationsArgs,
  ctx: DebugContext,
  dependencies?: ProjectBuilderStudioTransportDependencies,
): Promise<ProjectBuilderToolResult> {
  const registry = resolveRegistry(ctx);
  const transportDependencies = dependencies ?? ctx.projectBuilderTransportDependencies;
  const provider = registry.getProvider(args.domain);
  return requestProjectBuilderStudio(
    ctx,
    {
      action: args.action,
      domain: provider.domain,
      route: provider.routeAdapter.buildRequest(args.action, {
        projectId: args.projectId,
        ...('operationId' in args && typeof args.operationId === 'string'
          ? { operationId: args.operationId }
          : {}),
        ...(args.input ? { input: args.input } : {}),
      }),
      timeoutMs: operationTimeout(args.action),
    },
    transportDependencies,
  );
}

function operationSchema<TAction extends string>(
  action: TAction,
  operationRequired: boolean,
  inputSchema: z.ZodType<unknown> = boundedInputSchema,
) {
  const shape = {
    action: z.literal(action),
    domain: domainSchema.default('workflow'),
    projectId: z.string().min(1),
    ...(operationRequired ? { operationId: z.string().min(1) } : {}),
    input: inputSchema,
  };
  return z.object(shape).strict();
}

function operationTimeout(action: PlatformProjectOperationsArgs['action']): number {
  const timeouts: Record<PlatformProjectOperationsArgs['action'], number> = {
    list: 10_000,
    read: 10_000,
    dependency_report: 30_000,
    readiness_report: 30_000,
    resume: 30_000,
    cancel: 15_000,
    create_confirmation_grant: 15_000,
    execute_action: 60_000,
  };
  return timeouts[action];
}

function resolveRegistry(ctx: DebugContext): ProjectBuilderDomainRegistry {
  return ctx.projectBuilderRegistry ?? createProductionProjectBuilderDomainRegistry();
}

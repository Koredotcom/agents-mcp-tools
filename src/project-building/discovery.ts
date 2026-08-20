import type { DebugContext } from '../tools/index.js';
import { platformProjectBuilder } from '../tools/platform-project-builder.js';
import type { ProjectBuilderDomainRegistry } from './contracts.js';

export const PROJECT_BUILDER_REGISTRY_URI = 'arch://project-builder/registry' as const;
export const PROJECT_BUILDER_PROVIDER_URI_PREFIX = 'arch://project-builder/providers/' as const;
export const PROJECT_BUILDER_LIVE_RESOURCE_TEMPLATE =
  'arch://project-builder/projects/{projectId}/dependency-report{?domains,includeReadiness}' as const;

export function listProjectBuilderResources(registry: ProjectBuilderDomainRegistry) {
  return [
    {
      uri: PROJECT_BUILDER_REGISTRY_URI,
      name: 'project-builder-registry',
      title: 'Arch project-builder registry',
      description: 'Domain-neutral project-building ontology, providers, and supported actions.',
      mimeType: 'application/json',
    },
    ...registry.providers.map(({ domain }) => ({
      uri: `${PROJECT_BUILDER_PROVIDER_URI_PREFIX}${domain}`,
      name: `project-builder-provider-${domain}`,
      title: `Arch project-builder provider: ${domain}`,
      description: `Static ${domain} provider ontology, schemas, lifecycle, and readiness ownership.`,
      mimeType: 'application/json',
    })),
  ];
}

export function listProjectBuilderResourceTemplates() {
  return [
    {
      uriTemplate: PROJECT_BUILDER_LIVE_RESOURCE_TEMPLATE,
      name: 'project-builder-project-report',
      title: 'Live Arch project dependency/readiness report',
      description:
        'Authenticated live project report. Uses the same capability negotiation and Studio visibility path as platform_project_builder.',
      mimeType: 'application/json',
    },
  ];
}

export async function readProjectBuilderResource(
  uri: string,
  registry: ProjectBuilderDomainRegistry,
  ctx: DebugContext,
) {
  if (uri === PROJECT_BUILDER_REGISTRY_URI) {
    return resource(uri, registry.describe());
  }
  if (uri.startsWith(PROJECT_BUILDER_PROVIDER_URI_PREFIX)) {
    const domain = decodeURIComponent(uri.slice(PROJECT_BUILDER_PROVIDER_URI_PREFIX.length));
    const provider = registry.getProvider(domain);
    return resource(uri, {
      ...registry.describe(domain),
      ontology: provider.ontology,
      actions: provider.actions,
      inputSchemas: provider.inputSchemas,
      outputSchemas: provider.outputSchemas,
      readinessOwner: provider.readinessOwner,
    });
  }

  const parsed = new URL(uri);
  if (parsed.protocol !== 'arch:' || parsed.hostname !== 'project-builder') {
    throw new Error(`Unknown project-builder resource: ${uri}`);
  }
  const match = parsed.pathname.match(/^\/projects\/([^/]+)\/dependency-report$/);
  if (!match) throw new Error(`Unknown project-builder resource: ${uri}`);
  const projectId = decodeURIComponent(match[1]);
  const domains = parsed.searchParams
    .get('domains')
    ?.split(',')
    .map((domain) => domain.trim())
    .filter(Boolean);
  const includeReadiness = parsed.searchParams.get('includeReadiness');
  const result = await platformProjectBuilder(
    {
      action: 'inspect',
      domain: 'project',
      projectId,
      ...(domains?.length ? { domains } : {}),
      ...(includeReadiness === null ? {} : { includeReadiness: includeReadiness === 'true' }),
    },
    ctx,
  );
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: result.content[0].text,
      },
    ],
  };
}

export function listProjectBuilderPrompts() {
  return [
    {
      name: 'build-agentic-project',
      title: 'Build an agentic project with Arch',
      description:
        'Inspect registered domains, obtain an authoritative dependency plan, and continue through durable operations.',
      arguments: [
        {
          name: 'projectId',
          description: 'Existing project ID when inspecting or extending.',
          required: false,
        },
        { name: 'goal', description: 'Outcome the project should deliver.', required: true },
        { name: 'domain', description: 'Provider domain; defaults to workflow.', required: false },
      ],
    },
    {
      name: 'continue-project-operation',
      title: 'Continue a durable Arch project operation',
      description: 'Read authoritative state and perform only the next allowed operation action.',
      arguments: [
        { name: 'projectId', description: 'Project ID.', required: true },
        { name: 'operationId', description: 'Durable operation ID.', required: true },
        { name: 'domain', description: 'Provider domain; defaults to workflow.', required: false },
      ],
    },
  ];
}

export function getProjectBuilderPrompt(name: string, args: Record<string, string> = {}) {
  if (name === 'build-agentic-project') {
    if (!args.goal) throw new Error('goal is required');
    const domain = args.domain || 'workflow';
    return {
      description: 'Use Arch as the authoritative project-building control plane.',
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Goal: ${args.goal}`,
              `Domain: ${domain}`,
              args.projectId
                ? `Project: ${args.projectId}`
                : 'Project: create or select one first.',
              'Call platform_project_builder describe (globally and for the selected provider) before planning.',
              'Use inspect with domain=project for live dependencies, then plan. Continue only through platform_project_builder_operations using returned versions, blockers, next actions, and grant bindings.',
              'Never place secrets in tool arguments; use opaque auth-profile and integration references.',
            ].join('\n'),
          },
        },
      ],
    };
  }
  if (name === 'continue-project-operation') {
    if (!args.projectId || !args.operationId) {
      throw new Error('projectId and operationId are required');
    }
    return {
      description: 'Continue an existing durable project-building operation.',
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Project: ${args.projectId}`,
              `Operation: ${args.operationId}`,
              `Domain: ${args.domain || 'workflow'}`,
              'Read the operation first. Respect its current version, blockers, readiness owner, and next actions.',
              'For side effects, plan and use the exact attempt-bound confirmation grant. Never retry a consumed action whose outcome is unknown.',
            ].join('\n'),
          },
        },
      ],
    };
  }
  throw new Error(`Unknown project-builder prompt: ${name}`);
}

function resource(uri: string, value: unknown) {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value) }],
  };
}

import {
  ARCH_KNOWLEDGE_LIMITS,
  ARCH_KNOWLEDGE_MEDIA_TYPE,
  ARCH_KNOWLEDGE_SCHEMA_VERSION,
  type ArchKnowledgeCatalog,
} from './contracts.js';
import { createArchKnowledgeCatalog } from './catalog.js';

export const ARCH_GUIDANCE_URI_PREFIX = 'arch://guidance/v1/' as const;
export const ARCH_GUIDANCE_MANIFEST_URI = `${ARCH_GUIDANCE_URI_PREFIX}manifest` as const;
export const ARCH_GUIDANCE_FEATURES_URI = `${ARCH_GUIDANCE_URI_PREFIX}features` as const;
export const ARCH_GUIDANCE_OPERATIONS_URI = `${ARCH_GUIDANCE_URI_PREFIX}operations` as const;
export const ARCH_GUIDANCE_DEPENDENCIES_URI = `${ARCH_GUIDANCE_URI_PREFIX}dependencies` as const;
export const ARCH_GUIDANCE_FEATURE_TEMPLATE =
  `${ARCH_GUIDANCE_URI_PREFIX}features/{featureId}` as const;
export const ARCH_GUIDANCE_TOOL_TEMPLATE = `${ARCH_GUIDANCE_URI_PREFIX}tools/{toolName}` as const;

const KNOWLEDGE_PROMPT_NAMES = new Set(['plan-platform-operation', 'verify-platform-operation']);

export type KnowledgeCatalogReader = () => ArchKnowledgeCatalog;

export function createKnowledgeCatalogReader(
  factory: () => ArchKnowledgeCatalog = createArchKnowledgeCatalog,
): KnowledgeCatalogReader {
  let catalog: ArchKnowledgeCatalog | undefined;
  return () => (catalog ??= factory());
}

const defaultKnowledgeCatalogReader = createKnowledgeCatalogReader();

export function isKnowledgeResourceUri(uri: string): boolean {
  return uri.startsWith(ARCH_GUIDANCE_URI_PREFIX);
}

export function isKnowledgePrompt(name: string): boolean {
  return KNOWLEDGE_PROMPT_NAMES.has(name);
}

export function listKnowledgeResources() {
  return [
    staticResource(ARCH_GUIDANCE_MANIFEST_URI, 'guidance-manifest', 'Arch guidance manifest'),
    staticResource(ARCH_GUIDANCE_FEATURES_URI, 'guidance-features', 'Arch feature knowledge'),
    staticResource(ARCH_GUIDANCE_OPERATIONS_URI, 'guidance-operations', 'Arch operation knowledge'),
    staticResource(
      ARCH_GUIDANCE_DEPENDENCIES_URI,
      'guidance-dependencies',
      'Arch feature dependency graph',
    ),
  ];
}

export function listKnowledgeResourceTemplates() {
  return [
    {
      uriTemplate: ARCH_GUIDANCE_FEATURE_TEMPLATE,
      name: 'guidance-feature-detail',
      title: 'Arch feature operation and dependency detail',
      description: 'Code-backed tool operations, dependencies, limitations, and verification.',
      mimeType: ARCH_KNOWLEDGE_MEDIA_TYPE,
    },
    {
      uriTemplate: ARCH_GUIDANCE_TOOL_TEMPLATE,
      name: 'guidance-tool-detail',
      title: 'Arch tool operation detail',
      description: 'Schema-derived operations and validated guidance for one published MCP tool.',
      mimeType: ARCH_KNOWLEDGE_MEDIA_TYPE,
    },
  ];
}

export function readKnowledgeResource(
  uri: string,
  readCatalog: KnowledgeCatalogReader = defaultKnowledgeCatalogReader,
) {
  const knowledge = readCatalog();
  if (uri === ARCH_GUIDANCE_MANIFEST_URI) {
    return resource(uri, {
      schemaVersion: knowledge.schemaVersion,
      generatedFrom: knowledge.generatedFrom,
      counts: {
        features: knowledge.features.length,
        tools: knowledge.tools.length,
        operations: knowledge.operations.length,
        dependencies: knowledge.dependencies.length,
      },
      limits: ARCH_KNOWLEDGE_LIMITS,
    });
  }
  if (uri === ARCH_GUIDANCE_FEATURES_URI) {
    return resource(
      uri,
      knowledge.features.map(({ id, title, summary, tools, dependencies }) => ({
        id,
        title,
        summary,
        toolCount: tools.length,
        dependencyCount: dependencies.length,
      })),
    );
  }
  if (uri === ARCH_GUIDANCE_OPERATIONS_URI) {
    return resource(
      uri,
      knowledge.operations.map(
        ({ id, featureId, capability, scope, safety, support, validatesWith }) => ({
          id,
          featureId,
          capability,
          scope,
          safety,
          support,
          validatesWith,
        }),
      ),
    );
  }
  if (uri === ARCH_GUIDANCE_DEPENDENCIES_URI) {
    return resource(uri, knowledge.dependencies);
  }

  const parsed = new URL(uri);
  if (parsed.protocol !== 'arch:' || parsed.hostname !== 'guidance') {
    throw new Error(`Unknown guidance resource: ${uri}`);
  }
  const featureMatch = parsed.pathname.match(/^\/v1\/features\/([^/]+)$/);
  if (featureMatch) {
    const featureId = decodeURIComponent(featureMatch[1]);
    const feature = knowledge.features.find(({ id }) => id === featureId);
    if (!feature) throw new Error(`Unknown Arch feature: ${featureId}`);
    return detailResource(uri, {
      schemaVersion: ARCH_KNOWLEDGE_SCHEMA_VERSION,
      feature,
      operations: knowledge.operations.filter(({ featureId: id }) => id === featureId),
      incomingDependencies: knowledge.dependencies.filter(({ to }) => to === featureId),
    });
  }
  const toolMatch = parsed.pathname.match(/^\/v1\/tools\/([^/]+)$/);
  if (toolMatch) {
    const toolName = decodeURIComponent(toolMatch[1]);
    const tool = knowledge.tools.find(({ name }) => name === toolName);
    if (!tool) throw new Error(`Unknown Arch tool: ${toolName}`);
    return detailResource(uri, { schemaVersion: ARCH_KNOWLEDGE_SCHEMA_VERSION, tool });
  }
  throw new Error(`Unknown guidance resource: ${uri}`);
}

export function listKnowledgePrompts() {
  return [
    {
      name: 'plan-platform-operation',
      title: 'Plan an Arch platform operation',
      description:
        'Resolve code-backed prerequisites, safety, limitations, and verification first.',
      arguments: [
        { name: 'goal', description: 'Outcome to achieve.', required: true },
        { name: 'featureId', description: 'Optional Arch feature ID.', required: false },
      ],
    },
    {
      name: 'verify-platform-operation',
      title: 'Verify an Arch platform operation',
      description: 'Use the catalog-defined verification operation after a tool action.',
      arguments: [
        { name: 'tool', description: 'Published Arch MCP tool name.', required: true },
        { name: 'action', description: 'Schema-derived action, or invoke.', required: true },
      ],
    },
  ];
}

export function getKnowledgePrompt(
  name: string,
  args: Record<string, string> = {},
  readCatalog: KnowledgeCatalogReader = defaultKnowledgeCatalogReader,
) {
  if (name === 'plan-platform-operation') {
    if (!args.goal) throw new Error('goal is required');
    const knowledge = readCatalog();
    const feature = args.featureId
      ? knowledge.features.find(({ id }) => id === args.featureId)
      : undefined;
    if (args.featureId && !feature) throw new Error(`Unknown Arch feature: ${args.featureId}`);
    return prompt(
      'Plan from the code-backed Arch operation catalog.',
      [
        `Goal: ${args.goal}`,
        feature ? `Feature: ${feature.id} — ${feature.title}` : 'Feature: discover before acting.',
        'Read arch://guidance/v1/manifest and the relevant feature/tool details.',
        'Resolve every required dependency before mutation. Treat authoritative-live readiness as project-specific.',
        'Respect operation safety. Never send raw secrets or blindly retry an unknown-outcome mutation.',
        'After acting, call the catalog-defined validatesWith operation and report evidence and limitations.',
      ].join('\n'),
    );
  }
  if (name === 'verify-platform-operation') {
    if (!args.tool || !args.action) throw new Error('tool and action are required');
    const operation = readCatalog().operations.find(
      ({ tool, action }) => tool === args.tool && action === args.action,
    );
    if (!operation) throw new Error(`Unknown Arch operation: ${args.tool}:${args.action}`);
    return prompt(
      'Verify an Arch operation using code-backed guidance.',
      [
        `Operation: ${operation.id}`,
        `Support: ${operation.support}`,
        `Safety: ${operation.safety}`,
        `Verify with: ${operation.validatesWith.tool} action=${operation.validatesWith.action}`,
        `Required verification context: ${operation.verificationRequiredContext.join('; ') || 'none'}`,
        `Expected evidence: ${operation.verificationExpectedEvidence}`,
        `Limitations: ${operation.limitations.join('; ') || 'none recorded'}`,
        'Do not claim success until the verification result is observed.',
      ].join('\n'),
    );
  }
  throw new Error(`Unknown guidance prompt: ${name}`);
}

function staticResource(uri: string, name: string, title: string) {
  return {
    uri,
    name,
    title,
    description: `${title}; schema-derived and validated against the published tool registry.`,
    mimeType: ARCH_KNOWLEDGE_MEDIA_TYPE,
  };
}

function resource(uri: string, value: unknown) {
  return boundedResource(uri, value, ARCH_KNOWLEDGE_LIMITS.maxIndexBytes);
}

function detailResource(uri: string, value: unknown) {
  return boundedResource(uri, value, ARCH_KNOWLEDGE_LIMITS.maxDetailBytes);
}

function boundedResource(uri: string, value: unknown, maximumBytes: number) {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maximumBytes) {
    throw new Error(`Guidance resource exceeds ${maximumBytes} bytes`);
  }
  return { contents: [{ uri, mimeType: ARCH_KNOWLEDGE_MEDIA_TYPE, text }] };
}

function prompt(description: string, text: string) {
  return {
    description,
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
  };
}

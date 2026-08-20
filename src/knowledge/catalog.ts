import { effectiveInputSchema, tools, type ToolDefinition } from '../tools/index.js';
import { getArchCapabilityForTool } from '../tools/persona.js';
import { createWorkflowDomainProvider } from '../project-building/domains/workflow.js';
import {
  ARCH_KNOWLEDGE_LIMITS,
  ARCH_KNOWLEDGE_SCHEMA_VERSION,
  type ArchKnowledgeCatalog,
  type FeatureDependency,
  type FeatureKnowledge,
  type OperationKnowledge,
  type OperationSafety,
  type OperationScope,
  type ToolKnowledge,
} from './contracts.js';
import { OPERATION_CONFIDENCE_EVIDENCE } from './confidence-evidence.js';
import {
  MUTATION_VERIFICATION_GUIDANCE,
  verificationGuidanceForOperation,
} from './verification-guidance.js';

interface FeatureDefinition {
  readonly title: string;
  readonly summary: string;
}

interface ToolSemantics {
  readonly featureId: keyof typeof FEATURE_DEFINITIONS;
  readonly scope: OperationScope;
  readonly requires?: readonly (keyof typeof FEATURE_DEFINITIONS)[];
  readonly limitations?: readonly string[];
}

type SafetyRules = Readonly<Record<OperationSafety, readonly string[]>>;

const FEATURE_DEFINITIONS = Object.freeze({
  'connection-context': {
    title: 'Connection and workspace context',
    summary: 'Authenticate, select an environment, and maintain the active workspace context.',
  },
  'live-agent-debug': {
    title: 'Live agent debugging',
    summary: 'Load agents, exchange messages, subscribe to sessions, and inspect live execution.',
  },
  'durable-observability': {
    title: 'Durable observability',
    summary: 'Inspect retained session history and produce bounded diagnostics.',
  },
  'documentation-ci': {
    title: 'Documentation and CI evidence',
    summary: 'Read public documentation and CI harness evidence.',
  },
  'governed-project-building': {
    title: 'Governed project building',
    summary: 'Discover authoritative domains, dependencies, readiness, and durable operations.',
  },
  'project-lifecycle': {
    title: 'Project lifecycle',
    summary: 'Create, inspect, update, list, and remove Agent Platform projects.',
  },
  'workflow-authoring': {
    title: 'Workflow authoring',
    summary: 'Create, validate, publish, execute, and expose workflows as tools.',
  },
  'arch-automation': {
    title: 'Arch automation',
    summary: 'Run staged SOP and autonomous project-repair operations.',
  },
  'credentials-connectors': {
    title: 'Credentials and connectors',
    summary: 'Manage auth profiles, integrations, and MCP servers through opaque references.',
  },
  'agent-tool-authoring': {
    title: 'Agent and tool authoring',
    summary: 'Manage agent DSL, project tools, tables, and project configuration.',
  },
  'release-delivery': {
    title: 'Release and delivery',
    summary: 'Create versions, qualify and deploy manifests, and configure SDK channels.',
  },
  'portability-repair': {
    title: 'Portability and repair',
    summary: 'Import, export, validate, model, lint, and diagnose project packages.',
  },
  evaluations: {
    title: 'Evaluations',
    summary: 'Manage personas, scenarios, evaluators, sets, runs, and evaluation evidence.',
  },
} satisfies Record<string, FeatureDefinition>);

const FEATURE_DEPENDENCIES = Object.freeze([
  dependency(
    'live-agent-debug',
    'connection-context',
    'requires',
    'code-corroborated',
    'Live WebSocket tools require an authenticated connection.',
    evidence('handler', 'debug_load_agent', 'invoke'),
  ),
  dependency(
    'durable-observability',
    'project-lifecycle',
    'requires',
    'code-corroborated',
    'Historical session reads are project scoped.',
    evidence('handler', 'debug_session_history', 'list'),
  ),
  dependency(
    'governed-project-building',
    'project-lifecycle',
    'requires',
    'authoritative-live',
    'Live dependency reports resolve an authorized project.',
    evidence('protocol-test', 'platform_project_builder_operations', 'dependency_report'),
  ),
  dependency(
    'workflow-authoring',
    'project-lifecycle',
    'requires',
    'code-corroborated',
    'Workflow routes are project scoped.',
    evidence('handler', 'platform_workflows', 'list'),
  ),
  dependency(
    'workflow-authoring',
    'credentials-connectors',
    'optional',
    'authoritative-live',
    'Workflow tool bindings may consume auth profiles and integrations.',
    evidence('protocol-test', 'platform_project_builder_operations', 'dependency_report'),
  ),
  dependency(
    'arch-automation',
    'governed-project-building',
    'consumes',
    'code-corroborated',
    'Arch automation consumes staged project-building operations.',
    evidence('handler', 'platform_arch_sop', 'create_project'),
  ),
  dependency(
    'credentials-connectors',
    'project-lifecycle',
    'requires',
    'code-corroborated',
    'Integration and MCP server resources are project scoped.',
    evidence('handler', 'platform_integrations', 'list'),
  ),
  dependency(
    'agent-tool-authoring',
    'project-lifecycle',
    'requires',
    'code-corroborated',
    'Agent, tool, table, and configuration resources are project scoped.',
    evidence('handler', 'platform_agents', 'list'),
  ),
  dependency(
    'agent-tool-authoring',
    'credentials-connectors',
    'optional',
    'authoritative-live',
    'Project tools may bind integrations or imported MCP tools.',
    evidence('protocol-test', 'platform_project_builder_operations', 'dependency_report'),
  ),
  dependency(
    'release-delivery',
    'agent-tool-authoring',
    'requires',
    'code-corroborated',
    'Version manifests capture authored agent/tool configuration.',
    evidence('handler', 'platform_versions', 'create'),
  ),
  dependency(
    'release-delivery',
    'workflow-authoring',
    'optional',
    'code-corroborated',
    'Deployment manifests may include a workflow version.',
    evidence('handler', 'platform_deployments', 'create'),
  ),
  dependency(
    'portability-repair',
    'project-lifecycle',
    'optional',
    'code-corroborated',
    'Import preview and apply target a project; local validation can run without one.',
    evidence('handler', 'platform_import_export', 'import_preview'),
  ),
  dependency(
    'evaluations',
    'project-lifecycle',
    'requires',
    'code-corroborated',
    'Evaluation assets and runs are project scoped.',
    evidence('handler', 'platform_eval_runs', 'list'),
  ),
  dependency(
    'evaluations',
    'release-delivery',
    'optional',
    'code-corroborated',
    'Evaluation preflight and runs may validate deployable versions.',
    evidence('handler', 'platform_eval_runs', 'preflight'),
  ),
] satisfies readonly FeatureDependency[]);

const TOOL_SEMANTICS = Object.freeze({
  platform_connect: semantics('connection-context', 'global'),
  platform_workspaces: semantics('connection-context', 'workspace'),
  debug_list_agents: semantics('live-agent-debug', 'global', { requires: ['connection-context'] }),
  debug_load_agent: semantics('live-agent-debug', 'operation', {
    requires: ['connection-context'],
  }),
  debug_send_message: semantics('live-agent-debug', 'operation', {
    requires: ['connection-context'],
  }),
  debug_traces: semantics('live-agent-debug', 'operation', { requires: ['connection-context'] }),
  debug_get_current_state: semantics('live-agent-debug', 'operation', {
    requires: ['connection-context'],
  }),
  debug_get_span_tree: semantics('live-agent-debug', 'operation', {
    requires: ['connection-context'],
  }),
  debug_get_errors: semantics('live-agent-debug', 'operation', {
    requires: ['connection-context'],
  }),
  debug_explain_decision: semantics('live-agent-debug', 'operation', {
    requires: ['connection-context'],
  }),
  debug_get_flow_graph: semantics('live-agent-debug', 'operation', {
    requires: ['connection-context'],
  }),
  debug_list_active_sessions: semantics('live-agent-debug', 'global', {
    requires: ['connection-context'],
  }),
  debug_session: semantics('live-agent-debug', 'operation', {
    requires: ['connection-context'],
  }),
  debug_analyze_session: semantics('live-agent-debug', 'operation', {
    requires: ['connection-context'],
  }),
  debug_session_history: semantics('durable-observability', 'project'),
  debug_diagnose: semantics('durable-observability', 'operation'),
  debug_docs: semantics('documentation-ci', 'global'),
  debug_harness_logs: semantics('documentation-ci', 'project'),
  platform_project_builder: semantics('governed-project-building', 'project'),
  platform_project_builder_operations: semantics('governed-project-building', 'operation'),
  platform_projects: semantics('project-lifecycle', 'tenant'),
  platform_workflows: semantics('workflow-authoring', 'project'),
  platform_arch_sop: semantics('arch-automation', 'operation'),
  platform_arch_auto_loop: semantics('arch-automation', 'operation'),
  platform_auth_profiles: semantics('credentials-connectors', 'project', {
    limitations: ['Never pass raw secrets outside dedicated secret-collection flows.'],
  }),
  platform_integrations: semantics('credentials-connectors', 'project'),
  platform_mcp_servers: semantics('credentials-connectors', 'project'),
  platform_agents: semantics('agent-tool-authoring', 'project'),
  platform_tools: semantics('agent-tool-authoring', 'project'),
  agent_tables: semantics('agent-tool-authoring', 'project'),
  platform_config: semantics('agent-tool-authoring', 'project'),
  platform_versions: semantics('release-delivery', 'project'),
  platform_deployments: semantics('release-delivery', 'project'),
  platform_sdk_channels: semantics('release-delivery', 'project'),
  platform_import_export: semantics('portability-repair', 'project'),
  platform_validate_package: semantics('portability-repair', 'project'),
  platform_package_model: semantics('portability-repair', 'global'),
  debug_lint_abl: semantics('portability-repair', 'global'),
  debug_why_transcript_failed: semantics('portability-repair', 'global'),
  debug_diagnose_transcript: semantics('portability-repair', 'global'),
  platform_eval_personas: semantics('evaluations', 'project'),
  platform_eval_scenarios: semantics('evaluations', 'project'),
  platform_eval_evaluators: semantics('evaluations', 'project'),
  platform_eval_sets: semantics('evaluations', 'project'),
  platform_eval_runs: semantics('evaluations', 'project'),
} satisfies Record<string, ToolSemantics>);

const TOOL_OPERATION_SAFETY = Object.freeze({
  platform_connect: rules([], [], ['invoke']),
  debug_list_agents: rules(['invoke']),
  debug_load_agent: rules([], ['invoke']),
  debug_send_message: rules([], ['invoke']),
  debug_traces: rules(['invoke']),
  debug_session_history: rules(['list', 'get']),
  debug_get_current_state: rules(['invoke']),
  debug_get_span_tree: rules(['invoke']),
  debug_get_errors: rules(['invoke']),
  debug_explain_decision: rules(['invoke']),
  debug_get_flow_graph: rules(['invoke']),
  debug_list_active_sessions: rules(['invoke']),
  debug_session: rules([], [], ['subscribe', 'unsubscribe']),
  debug_docs: rules(['invoke']),
  debug_analyze_session: rules(['invoke']),
  debug_harness_logs: rules(['invoke']),
  debug_diagnose: rules(['invoke']),
  platform_project_builder: projectBuilderRules(['describe', 'inspect', 'plan']),
  platform_project_builder_operations: projectBuilderRules([
    'list',
    'read',
    'dependency_report',
    'readiness_report',
    'resume',
    'cancel',
    'create_confirmation_grant',
    'execute_action',
  ]),
  platform_projects: rules(['list', 'get'], ['create', 'update'], [], [], ['delete']),
  platform_workflows: rules(
    ['list', 'get'],
    ['create', 'update', 'execute', 'create_tool'],
    [],
    ['publish'],
    ['delete'],
  ),
  platform_arch_sop: rules(
    ['get_session'],
    ['create_session', 'upload_file', 'send_message', 'continue', 'create_project', 'recover'],
    [],
    [],
    ['cancel'],
  ),
  platform_arch_auto_loop: rules(
    ['list', 'get'],
    ['create', 'record_decision'],
    [],
    ['execute_action'],
  ),
  platform_auth_profiles: rules(
    ['list', 'get', 'providers', 'integrations'],
    ['create', 'update', 'oauth_initiate'],
    [],
    ['validate'],
    ['revoke', 'delete'],
  ),
  platform_integrations: rules(['list', 'get'], ['create', 'update'], [], ['test'], ['delete']),
  platform_mcp_servers: rules(
    ['list', 'get', 'grant_status', 'list_tools'],
    ['create', 'update', 'authorize', 'discover_import'],
    [],
    ['test_connection', 'discover_preview', 'test_tool'],
    ['delete', 'disconnect'],
  ),
  platform_agents: rules(['list', 'get'], ['save_dsl']),
  platform_versions: rules(
    ['list', 'get', 'diff', 'qualifications', 'audit'],
    ['create'],
    [],
    ['promote', 'publish'],
  ),
  platform_deployments: rules(
    ['list', 'get'],
    ['create'],
    [],
    ['promote', 'rollback', 'restore', 'retire'],
  ),
  platform_sdk_channels: rules(['list_keys', 'list_channels'], ['create_key', 'create_channel']),
  platform_tools: rules(['list', 'get'], ['create', 'update'], [], ['test'], ['delete']),
  agent_tables: rules(
    ['availability', 'list', 'describe', 'query', 'get_row', 'reveal'],
    ['create', 'update', 'migrate', 'insert', 'update_row', 'upsert'],
    [],
    [],
    ['delete', 'delete_row'],
  ),
  platform_import_export: rules(['export_preview', 'export', 'import_preview'], ['import']),
  platform_validate_package: rules(['invoke']),
  platform_package_model: rules(['invoke']),
  debug_lint_abl: rules(['invoke']),
  debug_why_transcript_failed: rules(['invoke']),
  debug_diagnose_transcript: rules(['invoke']),
  platform_eval_personas: rules(
    ['list', 'get', 'templates'],
    ['create', 'update', 'generate'],
    [],
    [],
    ['delete'],
  ),
  platform_eval_scenarios: rules(
    ['list', 'get'],
    ['create', 'update', 'generate'],
    [],
    [],
    ['delete'],
  ),
  platform_eval_evaluators: rules(
    ['list', 'get', 'templates'],
    ['create', 'update'],
    [],
    [],
    ['delete'],
  ),
  platform_eval_sets: rules(['list', 'get'], ['create', 'update'], [], [], ['delete']),
  platform_eval_runs: rules(
    ['list', 'get', 'status', 'heatmap', 'cases', 'compare', 'preflight'],
    ['create', 'update', 'start', 'quick'],
    [],
    [],
    ['cancel'],
  ),
  platform_config: rules(
    ['get_settings', 'get_llm_config'],
    ['update_settings', 'update_llm_config'],
  ),
  platform_workspaces: rules(['list', 'current'], [], ['switch']),
} satisfies Record<string, SafetyRules>);

export function createArchKnowledgeCatalog(
  definitions: readonly ToolDefinition[] = tools,
): ArchKnowledgeCatalog {
  const definitionNames = definitions.map(({ name }) => name);
  const semanticNames = Object.keys(TOOL_SEMANTICS);
  assertSameSet('tool knowledge', definitionNames, semanticNames);
  const derivedOperationIds = definitions.flatMap((definition) =>
    extractToolActions(definition).map((action) => `${definition.name}:${action}`),
  );
  assertSameSet(
    'operation confidence evidence',
    derivedOperationIds,
    Object.keys(OPERATION_CONFIDENCE_EVIDENCE),
  );

  const toolKnowledge = definitions.map((tool) => buildToolKnowledge(tool));
  const operations = toolKnowledge.flatMap(({ operations: entries }) => entries);
  assertSameSet(
    'mutation verification guidance',
    operations.filter(({ safety }) => safety !== 'read').map(({ id }) => id),
    Object.keys(MUTATION_VERIFICATION_GUIDANCE),
  );
  validateOperationKnowledge(operations);
  validateFeatureDependencies(operations);

  const features = Object.entries(FEATURE_DEFINITIONS).map(([id, definition]) => {
    const feature: FeatureKnowledge = {
      id,
      ...definition,
      dependencies: FEATURE_DEPENDENCIES.filter(({ from }) => from === id),
      tools: toolKnowledge.filter(({ featureId }) => featureId === id).map(({ name }) => name),
    };
    if (feature.tools.length === 0) throw new Error(`Feature has no published tools: ${id}`);
    return deepFreeze(feature);
  });

  enforceCount('features', features.length, ARCH_KNOWLEDGE_LIMITS.maxFeatures);
  enforceCount('tools', toolKnowledge.length, ARCH_KNOWLEDGE_LIMITS.maxTools);
  enforceCount('operations', operations.length, ARCH_KNOWLEDGE_LIMITS.maxOperations);
  enforceCount('dependencies', FEATURE_DEPENDENCIES.length, ARCH_KNOWLEDGE_LIMITS.maxDependencies);

  return deepFreeze({
    schemaVersion: ARCH_KNOWLEDGE_SCHEMA_VERSION,
    generatedFrom: 'runtime-tool-registry',
    features,
    tools: toolKnowledge,
    operations,
    dependencies: [...FEATURE_DEPENDENCIES],
  });
}

export function extractToolActions(tool: ToolDefinition): readonly string[] {
  const schema = effectiveInputSchema(tool);
  const actions = new Set<string>();
  collectActions(schema, actions);
  return actions.size === 0 ? ['invoke'] : [...actions].sort();
}

function collectActions(value: unknown, target: Set<string>): void {
  if (!isRecord(value)) return;
  const properties = isRecord(value.properties) ? value.properties : undefined;
  const action = properties && isRecord(properties.action) ? properties.action : undefined;
  if (action) {
    if (typeof action.const === 'string') target.add(action.const);
    if (Array.isArray(action.enum)) {
      for (const entry of action.enum) if (typeof entry === 'string') target.add(entry);
    }
  }
  for (const branchName of ['oneOf', 'anyOf', 'allOf']) {
    const branches = value[branchName];
    if (Array.isArray(branches)) for (const branch of branches) collectActions(branch, target);
  }
}

function buildToolKnowledge(tool: ToolDefinition): ToolKnowledge {
  const semantic = TOOL_SEMANTICS[tool.name as keyof typeof TOOL_SEMANTICS];
  if (!semantic) throw new Error(`Missing tool knowledge for ${tool.name}`);
  const actions = extractToolActions(tool);
  const operations = actions.map((action) => {
    const id = `${tool.name}:${action}`;
    const confidence = OPERATION_CONFIDENCE_EVIDENCE[id];
    if (!confidence) throw new Error(`Missing operation confidence evidence for ${id}`);
    const protocolVerified = confidence.protocolTestRef !== undefined;
    const explicitlyUnsupported =
      id === 'platform_versions:create' || id === 'platform_versions:promote';
    const safety = resolveSafety(tool.name, action);
    const verification = verificationGuidanceForOperation(id, safety);
    const operation: OperationKnowledge = {
      id,
      tool: tool.name,
      action,
      featureId: semantic.featureId,
      capability: getArchCapabilityForTool(tool.name),
      scope: semantic.scope,
      safety,
      support: explicitlyUnsupported
        ? 'unsupported'
        : protocolVerified
          ? 'verified'
          : 'implemented',
      confidenceBasis: protocolVerified ? 'protocol-verified' : 'implementation-backed',
      requires: [
        ...new Set([...(semantic.requires ?? []), ...featureRequirements(semantic.featureId)]),
      ],
      validatesWith: verification.validatesWith,
      verificationRequiredContext: verification.requiredContext,
      verificationExpectedEvidence: verification.expectedEvidence,
      limitations: semantic.limitations ?? [],
      evidence: [
        { kind: 'tool-registry', tool: tool.name, ref: `registry:${tool.name}` },
        { kind: 'input-schema', tool: tool.name, action, ref: `schema:${id}` },
        { kind: 'handler', tool: tool.name, action, ref: `handler:${id}` },
        { kind: 'focused-test', tool: tool.name, action, ref: confidence.focusedTestRef },
        ...(confidence.protocolTestRef
          ? [
              {
                kind: 'protocol-test' as const,
                tool: tool.name,
                action,
                ref: confidence.protocolTestRef,
              },
            ]
          : []),
      ],
    };
    return deepFreeze(operation);
  });
  return deepFreeze({
    name: tool.name,
    description: tool.description,
    featureId: semantic.featureId,
    capability: getArchCapabilityForTool(tool.name),
    operations,
  });
}

function resolveSafety(tool: string, action: string): OperationSafety {
  const rule = TOOL_OPERATION_SAFETY[tool as keyof typeof TOOL_OPERATION_SAFETY];
  if (!rule) throw new Error(`Missing safety knowledge for ${tool}`);
  const matches = (Object.entries(rule) as Array<[OperationSafety, readonly string[]]>).filter(
    ([, actions]) => actions.includes(action),
  );
  if (matches.length !== 1) throw new Error(`Safety knowledge drift for ${tool}:${action}`);
  return matches[0][0];
}

function featureRequirements(featureId: keyof typeof FEATURE_DEFINITIONS): readonly string[] {
  return FEATURE_DEPENDENCIES.filter(
    ({ from, kind }) => from === featureId && kind === 'requires',
  ).map(({ to }) => to);
}

export function validateOperationKnowledge(operations: readonly OperationKnowledge[]): void {
  const ids = new Set(operations.map(({ id }) => id));
  if (ids.size !== operations.length) throw new Error('Duplicate operation knowledge id');
  for (const operation of operations) {
    const evidenceKinds = new Set(operation.evidence.map(({ kind }) => kind));
    for (const evidence of operation.evidence) {
      if (
        evidence.tool !== operation.tool ||
        (evidence.action && evidence.action !== operation.action)
      ) {
        throw new Error(`Evidence does not resolve to ${operation.id}`);
      }
    }
    for (const required of ['tool-registry', 'input-schema', 'handler', 'focused-test'] as const) {
      if (!evidenceKinds.has(required))
        throw new Error(`Missing ${required} evidence for ${operation.id}`);
    }
    const confidence = OPERATION_CONFIDENCE_EVIDENCE[operation.id];
    if (!confidence) throw new Error(`Missing confidence inventory for ${operation.id}`);
    if (
      !operation.evidence.some(
        ({ kind, ref }) => kind === 'focused-test' && ref === confidence.focusedTestRef,
      )
    ) {
      throw new Error(`Focused evidence is stale for ${operation.id}`);
    }
    if (operation.support === 'verified' && !evidenceKinds.has('protocol-test')) {
      throw new Error(`Verified operation lacks protocol evidence: ${operation.id}`);
    }
    if (
      (operation.support === 'verified') !== (operation.confidenceBasis === 'protocol-verified') ||
      (confidence.protocolTestRef !== undefined) !== evidenceKinds.has('protocol-test')
    ) {
      throw new Error(`Confidence basis drift for ${operation.id}`);
    }
    if (
      confidence.protocolTestRef &&
      !operation.evidence.some(
        ({ kind, ref }) => kind === 'protocol-test' && ref === confidence.protocolTestRef,
      )
    ) {
      throw new Error(`Protocol evidence is stale for ${operation.id}`);
    }
    const target = `${operation.validatesWith.tool}:${operation.validatesWith.action}`;
    if (!ids.has(target)) {
      throw new Error(`Unknown verification operation ${target} referenced by ${operation.id}`);
    }
    if (!operation.verificationExpectedEvidence.trim()) {
      throw new Error(`Missing verification outcome guidance for ${operation.id}`);
    }
  }
}

export function validateFeatureDependencies(
  operations: readonly OperationKnowledge[],
  dependencies: readonly FeatureDependency[] = FEATURE_DEPENDENCIES,
  knownFeatureIds: readonly string[] = Object.keys(FEATURE_DEFINITIONS),
): void {
  const featureIds = new Set(knownFeatureIds);
  const operationIds = new Set(operations.map(({ id }) => id));
  const ids = new Set<string>();
  for (const edge of dependencies) {
    if (!featureIds.has(edge.from) || !featureIds.has(edge.to)) {
      throw new Error(`Dangling feature dependency ${edge.from} -> ${edge.to}`);
    }
    if (edge.from === edge.to) throw new Error(`Self dependency ${edge.from}`);
    if (edge.evidence.length === 0)
      throw new Error(`Dependency lacks evidence ${edge.from} -> ${edge.to}`);
    for (const item of edge.evidence) {
      const operationId = `${item.tool}:${item.action ?? 'invoke'}`;
      if (
        !operationIds.has(operationId) ||
        (item.kind !== 'handler' && item.kind !== 'protocol-test')
      ) {
        throw new Error(`Invalid dependency evidence ${operationId}`);
      }
    }
    if (
      edge.authority === 'authoritative-live' &&
      !edge.evidence.some(({ kind }) => kind === 'protocol-test')
    ) {
      throw new Error(`Live dependency lacks protocol evidence ${edge.from} -> ${edge.to}`);
    }
    const id = `${edge.from}:${edge.to}:${edge.kind}`;
    if (ids.has(id)) throw new Error(`Duplicate feature dependency ${id}`);
    ids.add(id);
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of dependencies) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Feature dependency cycle detected at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of adjacency.get(id) ?? []) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const featureId of featureIds) visit(featureId);
}

function enforceCount(label: string, value: number, maximum: number): void {
  if (value > maximum) throw new Error(`${label} exceeds ${maximum}`);
}

function assertSameSet(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((value) => !actualSet.has(value));
  const extra = actual.filter((value) => !expectedSet.has(value));
  if (missing.length || extra.length || actualSet.size !== actual.length) {
    throw new Error(`${label} drift: missing=[${missing.join(',')}], extra=[${extra.join(',')}]`);
  }
}

function semantics(
  featureId: keyof typeof FEATURE_DEFINITIONS,
  scope: OperationScope,
  options: Omit<ToolSemantics, 'featureId' | 'scope'> = {},
): ToolSemantics {
  return { featureId, scope, ...options };
}

function rules(
  read: readonly string[],
  write: readonly string[] = [],
  idempotentWrite: readonly string[] = [],
  grantGatedWrite: readonly string[] = [],
  destructiveWrite: readonly string[] = [],
): SafetyRules {
  return {
    read,
    write,
    idempotent_write: idempotentWrite,
    grant_gated_write: grantGatedWrite,
    destructive_write: destructiveWrite,
  };
}

function projectBuilderRules(actions: readonly string[]): SafetyRules {
  const providerModes = new Map(
    createWorkflowDomainProvider().actions.map(({ id, mode }) => [
      id.slice('workflow:'.length),
      mode,
    ]),
  );
  const grouped: Record<OperationSafety, string[]> = {
    read: [],
    write: [],
    idempotent_write: [],
    grant_gated_write: [],
    destructive_write: [],
  };
  for (const action of actions) {
    const mode = providerModes.get(action);
    if (!mode) throw new Error(`Workflow provider lacks project-builder action ${action}`);
    grouped[mode].push(action);
  }
  return grouped;
}

function dependency(
  from: keyof typeof FEATURE_DEFINITIONS,
  to: keyof typeof FEATURE_DEFINITIONS,
  kind: FeatureDependency['kind'],
  authority: FeatureDependency['authority'],
  description: string,
  firstEvidence: FeatureDependency['evidence'][number],
  ...additionalEvidence: Array<FeatureDependency['evidence'][number]>
): FeatureDependency {
  return {
    from,
    to,
    kind,
    authority,
    description,
    evidence: [firstEvidence, ...additionalEvidence],
  };
}

function evidence(
  kind: 'handler' | 'protocol-test',
  tool: string,
  action: string,
): FeatureDependency['evidence'][number] {
  return { kind, tool, action, ref: `${kind}:dependency:${tool}:${action}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

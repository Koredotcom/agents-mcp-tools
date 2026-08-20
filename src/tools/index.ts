/**
 * Tool Registry
 *
 * Centralizes all MCP tools and their schemas.
 */

import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { WebSocketClient } from '../client/websocket-client.js';
import type { HttpClient } from '../client/http-client.js';
import type { SessionStore } from '../store/session-store.js';
import type { TraceStore } from '../store/trace-store.js';
import type { AuthResult, AuthOptions } from '../client/auth-client.js';
import type { McpToolResult } from '../types.js';
import type {
  JsonSchema,
  ProjectBuilderDomainRegistry,
  ProjectBuilderToolResult,
} from '../project-building/contracts.js';
import type { ProjectBuilderStudioTransportDependencies } from '../project-building/studio-transport.js';

// Import tools
import { connect, connectSchema } from './connect.js';
import { listAgents, listAgentsSchema, loadAgent, loadAgentSchema } from './agents.js';
import { traces, tracesSchema } from './traces.js';
import {
  sessionHistory,
  sessionHistorySchema,
  SESSION_HISTORY_INPUT_SCHEMA,
  SESSION_HISTORY_TOOL_ANNOTATIONS,
} from './session-history.js';
import { getCurrentState, getCurrentStateSchema } from './state.js';
import { getSpanTree, getSpanTreeSchema } from './spans.js';
import { getErrors, getErrorsSchema } from './errors.js';
import { explainDecision, explainDecisionSchema } from './decisions.js';
import { getFlowGraph, getFlowGraphSchema } from './flow.js';
import { sendMessage, sendMessageSchema } from './interaction.js';
import {
  listActiveSessions,
  listActiveSessionsSchema,
  session,
  sessionSchema,
} from './subscription.js';
import { docs, docsSchema } from './docs.js';
import { analyzeSession, analyzeSessionSchema } from './analysis.js';
import { harnessLogs, harnessLogsSchema } from './harness-logs.js';
import { diagnose, diagnoseSchema } from './diagnose.js';
import { platformProjects, platformProjectsSchema } from './platform-projects.js';
import { platformWorkflows, platformWorkflowsSchema } from './platform-workflows.js';
import { platformAuthProfiles, platformAuthProfilesSchema } from './platform-auth-profiles.js';
import { platformIntegrations, platformIntegrationsSchema } from './platform-integrations.js';
import { platformMcpServers, platformMcpServersSchema } from './platform-mcp-servers.js';
import { platformAgents, platformAgentsSchema } from './platform-agents.js';
import { platformVersions, platformVersionsSchema } from './platform-versions.js';
import { platformDeployments, platformDeploymentsSchema } from './platform-deployments.js';
import { platformSdkChannels, platformSdkChannelsSchema } from './platform-sdk-channels.js';
import { platformTools, platformToolsSchema } from './platform-tools.js';
import { platformImportExport, platformImportExportSchema } from './platform-import-export.js';
import {
  platformValidatePackage,
  platformValidatePackageSchema,
} from './platform-validate-package.js';
import { platformPackageModel, platformPackageModelSchema } from './platform-package-model.js';
import { debugLintAbl, debugLintAblSchema } from './debug-lint-abl.js';
import {
  debugWhyTranscriptFailed,
  debugWhyTranscriptFailedSchema,
} from './debug-why-transcript-failed.js';
import {
  platformEvalPersonas,
  platformEvalPersonasSchema,
  platformEvalScenarios,
  platformEvalScenariosSchema,
  platformEvalEvaluators,
  platformEvalEvaluatorsSchema,
  platformEvalSets,
  platformEvalSetsSchema,
  platformEvalRuns,
  platformEvalRunsSchema,
} from './platform-evals.js';
import { platformConfig, platformConfigSchema } from './platform-config.js';
import { platformWorkspaces, platformWorkspacesSchema } from './platform-workspaces.js';
import { platformArchSop, platformArchSopSchema } from './platform-arch-sop.js';
import { platformArchAutoLoop, platformArchAutoLoopSchema } from './platform-arch-auto-loop.js';
import { agentTables, agentTablesSchema } from './agent-tables.js';
import {
  platformProjectBuilder,
  platformProjectBuilderSchema,
  platformProjectOperations,
  platformProjectOperationsSchema,
  PROJECT_BUILDER_OUTPUT_SCHEMA,
  PROJECT_BUILDER_TOOL_ANNOTATIONS,
  PROJECT_OPERATIONS_TOOL_ANNOTATIONS,
} from './platform-project-builder.js';

/**
 * Context passed to all tool handlers
 */
export interface DebugContext {
  wsClient: WebSocketClient;
  httpClient: HttpClient;
  sessionStore: SessionStore;
  traceStore: TraceStore;
  /** Authenticate using cascade: explicit token → stored credentials → device auth */
  authenticate: (options?: AuthOptions) => Promise<AuthResult>;
  /** Immutable provider registry supplied by the server/embedding application. */
  projectBuilderRegistry?: ProjectBuilderDomainRegistry;
  /** Narrow transport injection for embedding and real-protocol tests. */
  projectBuilderTransportDependencies?: ProjectBuilderStudioTransportDependencies;
}

/**
 * Tool definition
 */
export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType<unknown>;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  handler: (args: unknown, ctx: DebugContext) => Promise<string | McpToolResult<object>>;
}

type Assert<T extends true> = T;
type _ProjectBuilderResultCompatibility = Assert<
  ProjectBuilderToolResult extends McpToolResult<object> ? true : false
>;

/**
 * All available tools
 */
export const tools: ToolDefinition[] = [
  {
    name: 'platform_connect',
    description:
      'Connect to the server WebSocket to start receiving traces. Call this first before using other Arch debug tools. ' +
      'Auth is automatic — stored credentials or device auth are tried in order. ' +
      'If device auth is needed, the browser opens automatically and the tool polls until approved (single call, no two-phase). ' +
      'Credentials are saved to the MCP-owned credential store for future sessions. ' +
      'If already connected and a new authToken is provided, the authenticated WebSocket is safely replaced before the token is committed. ' +
      'Changing environments while connected is rejected unless force=true is explicitly provided. ' +
      'Every successful response includes activeTarget identity and environment metadata; surface it to the user when context changes. ' +
      'If no serverUrl is given and AGENTS_URL is unset, ask the user which environment to connect to ' +
      '(production/dev/staging/qa) instead of guessing. ' +
      'If it fails, report the error as-is to the user. Do NOT try alternative approaches like REST calls.',
    schema: connectSchema,
    handler: connect as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'debug_list_agents',
    description: 'List all available agents from the server. Returns agents grouped by domain.',
    schema: listAgentsSchema,
    handler: listAgents as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'debug_load_agent',
    description:
      'Load an agent and create a debug session. Use the agentPath format "domain/name" (e.g., "hotel-booking/booking_agent").',
    schema: loadAgentSchema,
    handler: loadAgent as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'debug_send_message',
    description: 'Send a message to the loaded agent and optionally wait for the response.',
    schema: sendMessageSchema,
    handler: sendMessage as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'debug_traces',
    description:
      'Get and search trace events. Filter by type, agent, text, error, or session. ' +
      'With no search filters (text/agentName/hasError), returns recent events. ' +
      'With search filters, searches across stored events.',
    schema: tracesSchema,
    handler: traces as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'debug_session_history',
    description:
      'List durable historical Runtime sessions or read a bounded page of persisted trace events. ' +
      'Use this explicitly when live debug buffers are unavailable or historical analysis is requested. ' +
      'Runtime is authoritative; this tool performs one paginated request and does not retry, hydrate live stores, or silently fall back.',
    schema: sessionHistorySchema,
    inputSchema: SESSION_HISTORY_INPUT_SCHEMA,
    annotations: SESSION_HISTORY_TOOL_ANNOTATIONS,
    handler: sessionHistory,
  },
  {
    name: 'debug_get_current_state',
    description:
      'Get the current agent state including context, gather progress, flow state, and more.',
    schema: getCurrentStateSchema,
    handler: getCurrentState as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'debug_get_span_tree',
    description:
      'Get hierarchical span tree showing execution flow. Useful for understanding agent behavior.',
    schema: getSpanTreeSchema,
    handler: getSpanTree as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'debug_get_errors',
    description:
      'Get all errors and warnings from the session. Includes escalations and constraint failures.',
    schema: getErrorsSchema,
    handler: getErrors as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'debug_explain_decision',
    description:
      'Get detailed explanation of a decision event with surrounding context. Helps understand why the agent made a choice.',
    schema: explainDecisionSchema,
    handler: explainDecision as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'debug_get_flow_graph',
    description:
      'Get the execution graph for any agent type (scripted, reasoning, or supervisor). Shows flow steps, tools, handoffs, and routing logic. Returns JSON or Mermaid diagram format.',
    schema: getFlowGraphSchema,
    handler: getFlowGraph as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  // Session subscription tools (for observing UI-created sessions)
  {
    name: 'debug_list_active_sessions',
    description:
      'List all active sessions from the server that can be subscribed to. Use this to find sessions created by the UI.',
    schema: listActiveSessionsSchema,
    handler: listActiveSessions as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'debug_session',
    description:
      "Subscribe to or unsubscribe from an existing session's trace events. " +
      "Use action='subscribe' to start receiving traces (buffered + live), " +
      "or action='unsubscribe' to stop. Use debug_list_active_sessions to find session IDs.",
    schema: sessionSchema,
    handler: session as (args: unknown, ctx: DebugContext) => Promise<string>,
  },

  // Documentation tools
  {
    name: 'debug_docs',
    description: `Get or search Agent ABL documentation from the platform. Requires platform_connect first. Provide 'topic' for full content, 'query' to search, or neither to list all available topics.`,
    schema: docsSchema,
    handler: docs as (args: unknown, ctx: DebugContext) => Promise<string>,
  },

  // Analysis tools
  {
    name: 'debug_analyze_session',
    description: `Get automated analysis and diagnostics for a session. Returns:
- Summary statistics (event counts, duration, LLM calls)
- Current state (step, collected fields, missing fields)
- Detected issues (loops, errors, constraint violations, tool failures)
- Suggestions for fixing problems

Use this as a starting point for debugging - it identifies common issues automatically.`,
    schema: analyzeSessionSchema,
    handler: analyzeSession as (args: unknown, ctx: DebugContext) => Promise<string>,
  },

  // Harness CI tools
  {
    name: 'debug_harness_logs',
    description: `Download and parse Harness CI execution logs. Returns parsed, readable log lines.

Use this to get full build/test failure logs beyond what an eval-run status summary includes.

Common usage:
- Get test failure details: stage_id="build_test", step_id="unit_tests" or "integration_tests"
- Get Docker build errors: stage_id="docker_search_ai", step_id="build_image"
- Get security scan failures: stage_id="docker_codetool_sandbox", step_id="trivy_scan"

Use the filter parameter to search for specific errors (e.g., "ECONNREFUSED|mongo|redis").
Requires HARNESS_API_KEY environment variable.`,
    schema: harnessLogsSchema,
    handler: harnessLogs as unknown as (args: unknown, ctx: DebugContext) => Promise<string>,
  },

  // Platform management tools
  {
    name: 'platform_project_builder',
    description:
      'Describe the domain-neutral project-building contract, inspect a provider, inspect authoritative live project dependencies/readiness, or plan work. Workflow is the first provider; future features use the same registry and envelope.',
    schema: platformProjectBuilderSchema,
    outputSchema: PROJECT_BUILDER_OUTPUT_SCHEMA,
    annotations: PROJECT_BUILDER_TOOL_ANNOTATIONS,
    handler: platformProjectBuilder as ToolDefinition['handler'],
  },
  {
    name: 'platform_project_builder_operations',
    description:
      'List, read, inspect, resume, cancel, grant, and execute durable project-building operations through a registered domain provider. Uses authoritative Studio state and attempt-bound governed actions.',
    schema: platformProjectOperationsSchema,
    outputSchema: PROJECT_BUILDER_OUTPUT_SCHEMA,
    annotations: PROJECT_OPERATIONS_TOOL_ANNOTATIONS,
    handler: platformProjectOperations as ToolDefinition['handler'],
  },
  {
    name: 'platform_projects',
    description:
      'Manage projects on the platform. Actions: list (all projects), get (by projectId), create (with name/description), update (modify name/description/entryAgentName by projectId), delete (by projectId).',
    schema: platformProjectsSchema,
    handler: platformProjects as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_workflows',
    description:
      'Manage node-based workflows end-to-end (Studio API → runtime). Actions: list, get, create, update, publish, execute, create_tool (expose a workflow as a ProjectTool for agent use), delete. Create supports every node type: start, end, function, condition, loop, delay, integration, human, data_entry, agent, tool, api. Edge sourceHandle rules: "on_success" for start/function/agent/tool/integration/api/delay/data_entry (+"on_failure" when config.onFailureEnabled); "on_approve"/"on_reject" for human; each condition id + "else" for condition; "on_complete"/"on_failure" for loop.',
    schema: platformWorkflowsSchema,
    handler: platformWorkflows as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_arch_sop',
    description:
      'Drive Studio Arch SOP-build sessions through the Studio API. Actions: create_session, get_session, upload_file, send_message, continue, create_project, recover, cancel. Use create_session for SOP/onboarding or in-project Arch sessions, upload_file to upload SOP/source files, send_message to submit SOP-build instructions or fileRefs, and create_project when Arch is ready to materialize the generated project.',
    schema: platformArchSopSchema,
    handler: platformArchSop as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_arch_auto_loop',
    description:
      'Drive Arch Auto Loop repair workflows through the Studio API. Actions: list, create, get, execute_action, record_decision for project-scoped Auto Loop runs.',
    schema: platformArchAutoLoopSchema,
    handler: platformArchAutoLoop as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_auth_profiles',
    description:
      'Manage project auth profiles without placing raw secrets in MCP context. Actions: list, get, create metadata, update metadata, validate, revoke, delete, providers, integrations, oauth_initiate. Complete secret entry or OAuth consent through the secure Studio flow returned by the platform.',
    schema: platformAuthProfilesSchema,
    handler: platformAuthProfiles as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_integrations',
    description:
      'Manage connector/integration connections that bind a connector to an auth profile. Actions: list, get, create, update, test, delete. Use platform_auth_profiles first when the connection requires authentication.',
    schema: platformIntegrationsSchema,
    handler: platformIntegrations as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_mcp_servers',
    description:
      'Provision MCP servers and turn discovered server tools into project tools. Actions: list, get, create, update, delete, test_connection, authorize, grant_status, disconnect, discover_preview, discover_import, list_tools, test_tool. Authentication is referenced by authProfileId; raw credentials are never accepted.',
    schema: platformMcpServersSchema,
    handler: platformMcpServers as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_agents',
    description:
      'Manage agents within a project. Actions: list (all agents in project), get (agent details including DSL), save_dsl (update agent DSL). Compilation happens implicitly during version creation.',
    schema: platformAgentsSchema,
    handler: platformAgents as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_versions',
    description:
      'Manage immutable agent versions. Actions: list, get, publish (current draft with raw-DSL hash guard), qualifications, audit, and diff. Legacy create/version-promote return migration guidance without HTTP calls.',
    schema: platformVersionsSchema,
    handler: platformVersions as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_deployments',
    description:
      'Manage deployments with typed version manifests. Actions: list, get, create, promote, rollback, restore, and retire. Rollback/restore/retire require explicit confirmation; qualification bypass requires a reason and existing server permission.',
    schema: platformDeploymentsSchema,
    handler: platformDeployments as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_sdk_channels',
    description:
      'Manage the public SDK bootstrap surface. Actions: list_keys, create_key (raw public key returned once), list_channels, create_channel (binds a web/mobile/API channel to a key and deployment environment).',
    schema: platformSdkChannelsSchema,
    handler: platformSdkChannels as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_tools',
    description:
      'Manage tools within a project. Actions: list (paginated tools; use page and limit to retrieve later pages), get (tool detail), create (new tool), update (modify tool), delete (remove tool), test (execute tool test with input and optional timeoutMs). Note: tool CRUD routes through the Studio API.',
    schema: platformToolsSchema,
    handler: platformTools as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'agent_tables',
    description:
      'Manage Agent Tables within a project. Actions: availability, list, describe, create, update, migrate, delete, insert, query, get_row, update_row, delete_row, upsert, reveal. Use availability first to diagnose TABLE_UNAVAILABLE. Delete actions require confirm=true.',
    schema: agentTablesSchema,
    handler: agentTables as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_import_export',
    description:
      'Import and export projects. Actions: export_preview (metadata preview), export (full project export as file map + manifest), import_preview (dry-run import showing changes), import (apply import). Import actions accept data.files, files, or a local folder/.zip path.',
    schema: platformImportExportSchema,
    handler: platformImportExport as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_validate_package',
    description:
      'Validate a local project folder/.zip or file map using platform-owned compiler and design diagnostics. Use in ABL repair/eval loops; returns normalized issues with suggested fixes.',
    schema: platformValidatePackageSchema,
    handler: platformValidatePackage as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_package_model',
    description:
      'Show what the platform compiler sees in a local project package: agents, tools, handoffs, memory variables, behavior profile references, flow steps, and unresolved refs.',
    schema: platformPackageModelSchema,
    handler: platformPackageModel as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'debug_lint_abl',
    description:
      'Run ABL design and repair lint checks for empty RESPOND values, empty finalize steps, undeclared handoff-condition variables, side-effect tool chains, and tool+text reasoning risks.',
    schema: debugLintAblSchema,
    handler: debugLintAbl as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'debug_why_transcript_failed',
    description:
      'Given a transcript JSON and exported package folder/.zip or file map, correlate transcript failure symptoms with ABL file/line diagnoses such as finalize -> COMPLETE -> RESPOND: "".',
    schema: debugWhyTranscriptFailedSchema,
    handler: debugWhyTranscriptFailed as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'debug_diagnose_transcript',
    description:
      'Alias for debug_why_transcript_failed. Given transcript JSON plus project files, returns correlated ABL file/line diagnoses.',
    schema: debugWhyTranscriptFailedSchema,
    handler: debugWhyTranscriptFailed as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_eval_personas',
    description:
      'Manage eval personas through the mounted Studio API paths under /api/projects/:projectId/evals/personas. Actions: list, get, create, update, delete, templates, generate.',
    schema: platformEvalPersonasSchema,
    handler: platformEvalPersonas as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_eval_scenarios',
    description:
      'Manage eval scenarios through /api/projects/:projectId/evals/scenarios. Actions: list, get, create, update, delete, generate.',
    schema: platformEvalScenariosSchema,
    handler: platformEvalScenarios as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_eval_evaluators',
    description:
      'Manage eval evaluators through /api/projects/:projectId/evals/evaluators. Actions: list, get, create, update, delete, templates.',
    schema: platformEvalEvaluatorsSchema,
    handler: platformEvalEvaluators as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_eval_sets',
    description:
      'Manage eval sets through /api/projects/:projectId/evals/sets. Actions: list, get, create, update, delete.',
    schema: platformEvalSetsSchema,
    handler: platformEvalSets as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_eval_runs',
    description:
      'Manage eval runs for ABL repair loops. Actions: list, get, create, update, start, cancel, status, heatmap, cases, compare, preflight, quick.',
    schema: platformEvalRunsSchema,
    handler: platformEvalRuns as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_config',
    description:
      'Manage project configuration. Actions: get_settings (project settings), update_settings (modify settings), get_llm_config (LLM configuration), update_llm_config (modify LLM config).',
    schema: platformConfigSchema,
    handler: platformConfig as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
  {
    name: 'platform_workspaces',
    description:
      'Manage workspaces (tenants). Actions: list (all workspaces the user belongs to, with active flag), switch (atomically authorize and switch the authenticated socket, credentials, and subsequent calls), current (show active workspace decoded from JWT). Responses include activeTarget and contextVersion; surface the active environment/workspace to the user after a switch.',
    schema: platformWorkspacesSchema,
    handler: platformWorkspaces as (args: unknown, ctx: DebugContext) => Promise<string>,
  },

  // Diagnostic tools
  {
    name: 'debug_diagnose',
    description:
      'Run diagnostic analysis on an agent or session. Returns config, findings, and suggestions. ' +
      'Provide sessionId for session diagnostics or agentName for agent config diagnostics. ' +
      'Set configOnly=true to inspect only config (model chain, credentials, tools) without running full diagnostics.',
    schema: diagnoseSchema,
    handler: diagnose as (args: unknown, ctx: DebugContext) => Promise<string>,
  },
];

/**
 * Get a tool by name
 */
export function getTool(name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}

/**
 * Convert Zod schema to JSON Schema for MCP
 */
export function zodToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  // Simple conversion - handle common types
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const zodValue = value as z.ZodType<unknown>;
      properties[key] = zodTypeToJsonSchema(zodValue);

      // Check if required (not optional)
      if (!(zodValue instanceof z.ZodOptional) && !(zodValue instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema.options as z.ZodType<unknown>[];
    return {
      type: 'object',
      oneOf: options.map((option) => zodToJsonSchema(option)),
    };
  }

  if (schema instanceof z.ZodUnion) {
    const options = schema.options as z.ZodType<unknown>[];
    return { anyOf: options.map((option) => zodTypeToJsonSchema(option)) };
  }

  return { type: 'object' };
}

/** The exact input schema published through MCP discovery. */
export function effectiveInputSchema(tool: ToolDefinition): JsonSchema {
  return tool.inputSchema ?? zodToJsonSchema(tool.schema);
}

function zodTypeToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  // Unwrap optional/default recursively until we get to the base type
  let innerSchema = schema;

  while (true) {
    if (innerSchema instanceof z.ZodOptional) {
      innerSchema = innerSchema.unwrap();
    } else if (innerSchema instanceof z.ZodDefault) {
      innerSchema = innerSchema._def.innerType;
    } else {
      break;
    }
  }

  const description = (schema as z.ZodType<unknown> & { _def: { description?: string } })._def
    ?.description;

  const base: Record<string, unknown> = {};
  if (description) {
    base.description = description;
  }

  if (innerSchema instanceof z.ZodString) {
    return { ...base, type: 'string' };
  }
  if (innerSchema instanceof z.ZodNumber) {
    return { ...base, type: 'number' };
  }
  if (innerSchema instanceof z.ZodBoolean) {
    return { ...base, type: 'boolean' };
  }
  if (innerSchema instanceof z.ZodArray) {
    return {
      ...base,
      type: 'array',
      items: zodTypeToJsonSchema(innerSchema.element),
    };
  }
  if (innerSchema instanceof z.ZodEnum) {
    return {
      ...base,
      type: 'string',
      enum: innerSchema.options,
    };
  }
  if (innerSchema instanceof z.ZodLiteral) {
    const value = innerSchema.value;
    return {
      ...base,
      const: value,
      type: value === null ? 'null' : typeof value,
    };
  }
  if (innerSchema instanceof z.ZodDiscriminatedUnion) {
    const options = innerSchema.options as z.ZodType<unknown>[];
    return {
      ...base,
      type: 'object',
      oneOf: options.map((option) => zodToJsonSchema(option)),
    };
  }
  if (innerSchema instanceof z.ZodUnion) {
    const options = innerSchema.options as z.ZodType<unknown>[];
    return {
      ...base,
      anyOf: options.map((option) => zodTypeToJsonSchema(option)),
    };
  }
  if (innerSchema instanceof z.ZodObject) {
    return { ...base, ...zodToJsonSchema(innerSchema) };
  }
  if (innerSchema instanceof z.ZodRecord) {
    return {
      ...base,
      type: 'object',
      additionalProperties: zodTypeToJsonSchema(innerSchema._def.valueType),
    };
  }

  return { ...base, type: 'string' };
}

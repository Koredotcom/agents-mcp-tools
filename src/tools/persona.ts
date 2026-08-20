/**
 * Arch MCP persona presentation.
 *
 * Tool handlers keep stable names and JSON contracts. This layer controls how
 * the MCP server presents those tools to clients.
 */

export const ARCH_MCP_SERVER_NAME = 'arch-agent-platform';
export const ARCH_MCP_SERVER_VERSION = '1.5.0';
export const ARCH_MCP_DISPLAY_NAME = 'Arch';
export const ARCH_MCP_LOG_PREFIX = '[Arch MCP]';
export const ARCH_MCP_ROUTE_KEY_PREFIX = 'arch-mcp';

export const ARCH_MCP_DESCRIPTION =
  'Arch is the Agent Platform MCP operator for Build, Evaluate, Optimize, Debug, and Analyze workflows.';

export const ARCH_CAPABILITY_ORDER = ['Build', 'Evaluate', 'Optimize', 'Debug', 'Analyze'] as const;

export type ArchCapability = (typeof ARCH_CAPABILITY_ORDER)[number];

interface ArchToolDescriptor {
  name: string;
  description: string;
}

const ARCH_CAPABILITY_CONTEXT: Record<ArchCapability, string> = {
  Build: 'creates and changes projects, agents, tools, configuration, versions, and deployments.',
  Evaluate: 'generates eval assets, runs eval workflows, and reads CI evidence.',
  Optimize: 'validates packages, inspects compiler-visible models, and drives repair loops.',
  Debug: 'connects to live sessions, traces failures, and inspects execution state.',
  Analyze: 'explains documentation, diagnostics, and system health signals.',
};

const ARCH_TOOL_CAPABILITY_BY_NAME: Record<string, ArchCapability> = {
  platform_connect: 'Debug',
  debug_list_agents: 'Debug',
  debug_load_agent: 'Debug',
  debug_send_message: 'Debug',
  debug_traces: 'Debug',
  debug_session_history: 'Debug',
  debug_get_current_state: 'Debug',
  debug_get_span_tree: 'Debug',
  debug_get_errors: 'Debug',
  debug_explain_decision: 'Debug',
  debug_get_flow_graph: 'Debug',
  debug_list_active_sessions: 'Debug',
  debug_session: 'Debug',

  debug_docs: 'Analyze',
  debug_analyze_session: 'Analyze',
  debug_diagnose: 'Analyze',

  debug_harness_logs: 'Evaluate',
  platform_eval_personas: 'Evaluate',
  platform_eval_scenarios: 'Evaluate',
  platform_eval_evaluators: 'Evaluate',
  platform_eval_sets: 'Evaluate',
  platform_eval_runs: 'Evaluate',

  platform_projects: 'Build',
  platform_agents: 'Build',
  platform_versions: 'Build',
  platform_deployments: 'Build',
  platform_tools: 'Build',
  platform_import_export: 'Build',
  platform_config: 'Build',
  platform_workspaces: 'Build',
  platform_workflows: 'Build',
  agent_tables: 'Build',
  platform_arch_sop: 'Build',
  platform_arch_auto_loop: 'Optimize',
  platform_project_builder: 'Build',
  platform_project_builder_operations: 'Build',
  platform_auth_profiles: 'Build',
  platform_integrations: 'Build',
  platform_mcp_servers: 'Build',
  platform_sdk_channels: 'Build',

  platform_validate_package: 'Optimize',
  platform_package_model: 'Optimize',
  debug_lint_abl: 'Optimize',
  debug_why_transcript_failed: 'Optimize',
  debug_diagnose_transcript: 'Optimize',
};

export function hasArchCapabilityForTool(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(ARCH_TOOL_CAPABILITY_BY_NAME, toolName);
}

export function getArchCapabilityForTool(toolName: string): ArchCapability {
  return ARCH_TOOL_CAPABILITY_BY_NAME[toolName] ?? 'Analyze';
}

export function formatArchToolDescription(tool: ArchToolDescriptor): string {
  const capability = getArchCapabilityForTool(tool.name);
  return `[Arch ${capability}] Arch ${ARCH_CAPABILITY_CONTEXT[capability]} ${tool.description}`;
}

export function formatArchToolSummary(tool: ArchToolDescriptor): string {
  const normalized = tool.description.replace(/\s+/g, ' ').trim();
  const firstPeriod = normalized.indexOf('.');
  return firstPeriod === -1 ? normalized : normalized.slice(0, firstPeriod);
}

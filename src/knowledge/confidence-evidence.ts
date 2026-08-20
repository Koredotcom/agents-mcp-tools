/**
 * Independent operation-to-test inventory used to justify actionable confidence.
 * Keep this separate from schemas, safety metadata, and feature semantics so a new
 * action cannot become actionable by updating only one of those sources.
 */

export interface OperationConfidenceEvidence {
  readonly focusedTestRef: string;
  readonly protocolTestRef?: string;
}

const FOCUSED_ACTIONS_BY_TOOL = Object.freeze({
  platform_connect: ['invoke'],
  debug_list_agents: ['invoke'],
  debug_load_agent: ['invoke'],
  debug_send_message: ['invoke'],
  debug_traces: ['invoke'],
  debug_session_history: ['get', 'list'],
  debug_get_current_state: ['invoke'],
  debug_get_span_tree: ['invoke'],
  debug_get_errors: ['invoke'],
  debug_explain_decision: ['invoke'],
  debug_get_flow_graph: ['invoke'],
  debug_list_active_sessions: ['invoke'],
  debug_session: ['subscribe', 'unsubscribe'],
  debug_docs: ['invoke'],
  debug_analyze_session: ['invoke'],
  debug_harness_logs: ['invoke'],
  platform_project_builder: ['describe', 'inspect', 'plan'],
  platform_project_builder_operations: [
    'cancel',
    'create_confirmation_grant',
    'dependency_report',
    'execute_action',
    'list',
    'read',
    'readiness_report',
    'resume',
  ],
  platform_projects: ['create', 'delete', 'get', 'list', 'update'],
  platform_workflows: [
    'create',
    'create_tool',
    'delete',
    'execute',
    'get',
    'list',
    'publish',
    'update',
  ],
  platform_arch_sop: [
    'cancel',
    'continue',
    'create_project',
    'create_session',
    'get_session',
    'recover',
    'send_message',
    'upload_file',
  ],
  platform_arch_auto_loop: ['create', 'execute_action', 'get', 'list', 'record_decision'],
  platform_auth_profiles: [
    'create',
    'delete',
    'get',
    'integrations',
    'list',
    'oauth_initiate',
    'providers',
    'revoke',
    'update',
    'validate',
  ],
  platform_integrations: ['create', 'delete', 'get', 'list', 'test', 'update'],
  platform_mcp_servers: [
    'authorize',
    'create',
    'delete',
    'disconnect',
    'discover_import',
    'discover_preview',
    'get',
    'grant_status',
    'list',
    'list_tools',
    'test_connection',
    'test_tool',
    'update',
  ],
  platform_agents: ['get', 'list', 'save_dsl'],
  platform_versions: [
    'audit',
    'create',
    'diff',
    'get',
    'list',
    'promote',
    'publish',
    'qualifications',
  ],
  platform_deployments: ['create', 'get', 'list', 'promote', 'restore', 'retire', 'rollback'],
  platform_sdk_channels: ['create_channel', 'create_key', 'list_channels', 'list_keys'],
  platform_tools: ['create', 'delete', 'get', 'list', 'test', 'update'],
  agent_tables: [
    'availability',
    'create',
    'delete',
    'delete_row',
    'describe',
    'get_row',
    'insert',
    'list',
    'migrate',
    'query',
    'reveal',
    'update',
    'update_row',
    'upsert',
  ],
  platform_import_export: ['export', 'export_preview', 'import', 'import_preview'],
  platform_validate_package: ['invoke'],
  platform_package_model: ['invoke'],
  debug_lint_abl: ['invoke'],
  debug_why_transcript_failed: ['invoke'],
  debug_diagnose_transcript: ['invoke'],
  platform_eval_personas: ['create', 'delete', 'generate', 'get', 'list', 'templates', 'update'],
  platform_eval_scenarios: ['create', 'delete', 'generate', 'get', 'list', 'update'],
  platform_eval_evaluators: ['create', 'delete', 'get', 'list', 'templates', 'update'],
  platform_eval_sets: ['create', 'delete', 'get', 'list', 'update'],
  platform_eval_runs: [
    'cancel',
    'cases',
    'compare',
    'create',
    'get',
    'heatmap',
    'list',
    'preflight',
    'quick',
    'start',
    'status',
    'update',
  ],
  platform_config: ['get_llm_config', 'get_settings', 'update_llm_config', 'update_settings'],
  platform_workspaces: ['current', 'list', 'switch'],
  debug_diagnose: ['invoke'],
} satisfies Record<string, readonly string[]>);

export const FOCUSED_OPERATION_TEST_SOURCE =
  'src/__tests__/operation-confidence.contract.test.ts' as const;

const FOCUSED_TEST_SOURCE_BY_TOOL: Readonly<Record<string, string>> = Object.freeze({
  platform_connect: 'src/__tests__/connect.test.ts',
  platform_workspaces: 'src/__tests__/platform-workspaces.test.ts',
});

const PROTOCOL_TEST_BY_OPERATION = Object.freeze({
  'debug_session_history:get': 'protocol:session-history-get',
  'debug_session_history:list': 'protocol:session-history-list',
  'platform_project_builder:describe': 'protocol:project-builder-describe',
  'platform_project_builder:inspect': 'protocol:project-builder-inspect',
  'platform_project_builder:plan': 'protocol:project-builder-plan',
  'platform_project_builder_operations:cancel': 'protocol:project-builder-cancel',
  'platform_project_builder_operations:read': 'protocol:project-builder-read',
} satisfies Record<string, string>);

export const PROTOCOL_TEST_SOURCE_BY_REF: Readonly<Record<string, string>> = Object.freeze({
  'protocol:session-history-get': 'src/__tests__/session-history.mcp.test.ts',
  'protocol:session-history-list': 'src/__tests__/session-history.mcp.test.ts',
  'protocol:project-builder-describe': 'src/__tests__/project-builder.mcp.e2e.test.ts',
  'protocol:project-builder-inspect': 'src/__tests__/project-builder.mcp.e2e.test.ts',
  'protocol:project-builder-plan': 'src/__tests__/project-builder.mcp.e2e.test.ts',
  'protocol:project-builder-cancel': 'src/__tests__/project-builder.mcp.e2e.test.ts',
  'protocol:project-builder-read': 'src/__tests__/project-builder.mcp.e2e.test.ts',
} satisfies Record<
  (typeof PROTOCOL_TEST_BY_OPERATION)[keyof typeof PROTOCOL_TEST_BY_OPERATION],
  string
>);

export const OPERATION_CONFIDENCE_EVIDENCE: Readonly<Record<string, OperationConfidenceEvidence>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(FOCUSED_ACTIONS_BY_TOOL).flatMap(([tool, actions]) =>
        actions.map((action) => {
          const id = `${tool}:${action}`;
          return [
            id,
            {
              focusedTestRef: `focused:${id}`,
              ...(PROTOCOL_TEST_BY_OPERATION[id as keyof typeof PROTOCOL_TEST_BY_OPERATION]
                ? {
                    protocolTestRef:
                      PROTOCOL_TEST_BY_OPERATION[id as keyof typeof PROTOCOL_TEST_BY_OPERATION],
                  }
                : {}),
            },
          ];
        }),
      ),
    ),
  );

export function focusedTestSourceForOperation(operationId: string): string | undefined {
  if (!OPERATION_CONFIDENCE_EVIDENCE[operationId]) return undefined;
  const tool = operationId.slice(0, operationId.lastIndexOf(':'));
  return FOCUSED_TEST_SOURCE_BY_TOOL[tool] ?? FOCUSED_OPERATION_TEST_SOURCE;
}
